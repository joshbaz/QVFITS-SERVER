import express from 'express';
import bcrypt from 'bcryptjs';

import prisma from '../../../utils/db.mjs';
import { env } from '../../../env.mjs';
import { AppError } from '../../../utils/AppError.js';
import { OWNER_ROLE, ensureSystemRoles, toStaffMember } from '../../../utils/permissions.mjs';
import { INVITE_TTL_MS, hashToken, randomToken } from '../../../utils/tokens.mjs';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { endSession, rotateSession, startSession } from './adminSession.mjs';
import { acceptInviteSchema, inviteSchema, loginSchema, setupSchema } from './schemas.mjs';

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const OWNER_SETUP_LOCK = 'owner-setup';
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const setupOpen = async () => {
    const [lock, staffCount] = await Promise.all([
        prisma.systemLock.findUnique({ where: { id: OWNER_SETUP_LOCK } }),
        prisma.staff.count(),
    ]);
    return !lock && staffCount === 0;
};

const withRole = (where) => prisma.staff.findUnique({
    where,
    include: { role: true },
    omit: { passwordHash: false },
});

/** Whether the one-time owner setup is still open, so the client knows to show it. */
router.get('/setup', async (req, res) => {
    res.json({ data: { open: await setupOpen() } });
});

/**
 * The one-time registration: creates the first admin as the owner and signs
 * them in. Once anyone is on the team it is closed for good. The lock's unique
 * id is created in the same transaction, so two requests at once can't both succeed.
 */
router.post('/setup', validate(setupSchema), async (req, res) => {
    const closed = () => new AppError('The shop already has an owner. Sign in instead.', 409, { code: 'SETUP_CLOSED' });
    if (!(await setupOpen())) throw closed();

    await ensureSystemRoles();
    const { name, email, password } = req.body;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let owner;
    try {
        owner = await prisma.$transaction(async (tx) => {
            await tx.systemLock.create({ data: { id: OWNER_SETUP_LOCK } });
            return tx.staff.create({
                data: { name, email, passwordHash, roleId: OWNER_ROLE, overrides: {}, status: 'active', lastSeenAt: new Date() },
                include: { role: true },
            });
        });
    } catch (error) {
        // P2002: the lock already exists; P2034: lost a write conflict with another setup.
        if (error?.code === 'P2002' || error?.code === 'P2034') throw closed();
        throw error;
    }

    res.status(201).json({ data: await startSession(res, owner, owner.role) });
});

router.post('/login', validate(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const staff = await withRole({ email });
    const matches = await bcrypt.compare(password, staff?.passwordHash ?? DUMMY_HASH);

    // One message for an unknown email and a wrong password, so neither reveals who is on the team.
    if (!staff || !staff.passwordHash || !matches) {
        throw new AppError('Email or password is incorrect.', 401, { code: 'INVALID_CREDENTIALS' });
    }
    if (staff.status === 'suspended') throw new AppError('Your access has been paused. Ask the owner.', 403);
    if (staff.status === 'invited') throw new AppError('Finish setting up your account from the invite link first.', 403);

    await prisma.staff.update({ where: { id: staff.id }, data: { lastSeenAt: new Date() } });
    res.json({ data: await startSession(res, staff, staff.role) });
});

router.post('/refresh', async (req, res) => {
    res.json({ data: await rotateSession(req, res) });
});

router.post('/logout', async (req, res) => {
    await endSession(req, res);
    res.status(204).end();
});

router.get('/me', requireAdmin, (req, res) => {
    res.json({ data: req.admin });
});

/**
 * Add someone to the team as `invited`. The link is returned for the inviter
 * to share until the server sends email; only its hash is stored.
 */
router.post('/invite', requireAdmin, requirePermission('team', 'edit'), validate(inviteSchema), async (req, res) => {
    const { name, email, roleId } = req.body;
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new AppError('Pick a role.', 422, { details: { fieldErrors: { roleId: ['Pick a role.'] } } });
    // Only an owner can make another owner, so a manager with team access can't promote past themselves.
    if (roleId === OWNER_ROLE && req.admin.role !== OWNER_ROLE) {
        throw new AppError('Only an owner can invite another owner.', 403);
    }
    if (await prisma.staff.findUnique({ where: { email } })) {
        throw new AppError('Someone on the team already uses that email.', 409);
    }

    const token = randomToken();
    const member = await prisma.staff.create({
        data: {
            name, email, roleId, overrides: {}, status: 'invited',
            inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
    });

    res.status(201).json({ data: { member: toStaffMember(member), inviteLink: `${env.APP_URL}/admin/invite?token=${token}` } });
});

/** An invited person sets their password and is signed straight in. */
router.post('/accept-invite', validate(acceptInviteSchema), async (req, res) => {
    const { token, password } = req.body;
    const used = () => new AppError('This invite link has been used or has expired. Ask for a new one.', 404);
    if (!token) throw used();

    const live = { inviteTokenHash: hashToken(token), status: 'invited', inviteExpiresAt: { gt: new Date() } };
    const invited = await prisma.staff.findFirst({ where: live, select: { id: true } });
    if (!invited) throw used();

    // Claim the invite in one write that only matches while it is still live, so the link works exactly once.
    const claimed = await prisma.staff.updateMany({
        where: { id: invited.id, ...live },
        data: {
            passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
            status: 'active', inviteTokenHash: null, inviteExpiresAt: null, lastSeenAt: new Date(),
        },
    });
    if (!claimed.count) throw used();

    const staff = await prisma.staff.findUnique({ where: { id: invited.id }, include: { role: true } });

    res.json({ data: await startSession(res, staff, staff.role) });
});

export default router;
