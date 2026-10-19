import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { OWNER_ROLE, cleanPermissions, toStaffMember } from '../../../utils/permissions.mjs';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { revokeAllSessions } from '../auth/adminSession.mjs';

/**
 * The people who can sign in to the admin and their roles. Only someone with
 * Team access can change them, nobody can lock the shop out of its last
 * owner, and only an owner can make or unmake another owner.
 */
const router = express.Router();
router.use(requireAdmin);

const permissionMap = z.record(z.string(), z.array(z.string())).transform(cleanPermissions);

const staffPatchSchema = z.object({
    name: z.string().trim().min(1, 'Enter a name').max(80).optional(),
    roleId: z.string().trim().min(1).optional(),
    overrides: permissionMap.optional(),
    // Invited is set by an invite and left by accepting it, never by hand.
    status: z.enum(['active', 'suspended']).optional(),
});

const roleFields = {
    name: z.string().trim().min(1, 'Name the role').max(60),
    description: z.string().trim().max(200),
    permissions: permissionMap,
};
// No defaults on an update: zod 4 applies defaults inside partial(), which would wipe unsent fields.
const rolePatchSchema = z.object(roleFields).partial();

// The client sends an id made from the name; tidy it into a slug ("Photo & video" becomes "photo-video").
const roleCreateSchema = z.object({
    ...roleFields,
    description: roleFields.description.default(''),
    permissions: permissionMap.default({}),
    id: z.string()
        .transform((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
        .pipe(z.string().min(1, 'Use letters or numbers in the role name').max(60)),
});

const toRole = ({ id, name, description, system, permissions }) => ({ id, name, description, system, permissions });

// How many active owners there would be without one person, so the shop can never be left with none.
const activeOwners = (exceptId) =>
    prisma.staff.count({ where: { roleId: OWNER_ROLE, status: 'active', id: { not: exceptId } } });

const findStaff = async (id) => {
    const member = /^[a-f0-9]{24}$/.test(id) ? await prisma.staff.findUnique({ where: { id } }) : null;
    if (!member) throw new AppError('That person is no longer on the team.', 404);
    return member;
};

const findRole = async (id) => {
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new AppError('That role no longer exists.', 404);
    return role;
};

const ownerOnly = (req, message) => {
    if (req.admin.role !== OWNER_ROLE) throw new AppError(message, 403);
};

/* People */

router.get('/staff', requirePermission('team', 'view'), async (req, res) => {
    const staff = await prisma.staff.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ data: staff.map(toStaffMember) });
});

router.patch('/staff/:id', requirePermission('team', 'edit'), validate(staffPatchSchema), async (req, res) => {
    const member = await findStaff(req.params.id);
    const patch = req.body;

    const changesRole = patch.roleId !== undefined && patch.roleId !== member.roleId;
    if (changesRole && (member.roleId === OWNER_ROLE || patch.roleId === OWNER_ROLE)) {
        ownerOnly(req, 'Only an owner can give or take away the owner role.');
    }
    if (member.roleId === OWNER_ROLE && patch.status === 'suspended') ownerOnly(req, 'Only an owner can pause another owner.');
    if (changesRole) await findRole(patch.roleId);

    const losingOwner = member.roleId === OWNER_ROLE && member.status === 'active' && (changesRole || patch.status === 'suspended');
    if (losingOwner && (await activeOwners(member.id)) === 0) {
        throw new AppError('The shop needs at least one active owner.', 409);
    }
    if (member.id === req.admin.id && patch.status === 'suspended') throw new AppError('You cannot suspend yourself.', 409);
    if (member.status === 'invited' && patch.status) throw new AppError('They have not accepted their invite yet.', 409);

    const updated = await prisma.staff.update({ where: { id: member.id }, data: patch });
    // A paused person is signed out at once, not when their refresh token runs out.
    if (patch.status === 'suspended') await revokeAllSessions(member.id);
    res.json({ data: toStaffMember(updated) });
});

router.delete('/staff/:id', requirePermission('team', 'delete'), async (req, res) => {
    const member = await findStaff(req.params.id);
    if (member.id === req.admin.id) throw new AppError('You cannot remove yourself.', 409);
    if (member.roleId === OWNER_ROLE) {
        ownerOnly(req, 'Only an owner can remove another owner.');
        if ((await activeOwners(member.id)) === 0) throw new AppError('The shop needs at least one active owner.', 409);
    }
    await prisma.$transaction([
        prisma.refreshToken.deleteMany({ where: { staffId: member.id } }),
        prisma.staff.delete({ where: { id: member.id } }),
    ]);
    res.status(204).end();
});

/* Roles */

// Every admin can read the roles: the role picker and the sidebar need the names.
router.get('/roles', async (req, res) => {
    const roles = await prisma.role.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ data: roles.map(toRole) });
});

router.post('/roles', requirePermission('team', 'edit'), validate(roleCreateSchema), async (req, res) => {
    if (await prisma.role.findUnique({ where: { id: req.body.id } })) {
        throw new AppError('A role with that name already exists.', 409);
    }
    const role = await prisma.role.create({ data: { ...req.body, system: false } });
    res.status(201).json({ data: toRole(role) });
});

router.patch('/roles/:id', requirePermission('team', 'edit'), validate(rolePatchSchema), async (req, res) => {
    const role = await findRole(req.params.id);
    if (role.id === OWNER_ROLE) throw new AppError('The owner always has full access.', 409);
    // Owner, Manager and Showroom staff keep their names; their access can still change.
    const { name, ...rest } = req.body;
    const updated = await prisma.role.update({ where: { id: role.id }, data: role.system ? rest : { name, ...rest } });
    res.json({ data: toRole(updated) });
});

router.delete('/roles/:id', requirePermission('team', 'delete'), async (req, res) => {
    const role = await findRole(req.params.id);
    if (role.system) throw new AppError('Owner, Manager and Showroom staff come with the shop and cannot be deleted.', 409);
    const using = await prisma.staff.count({ where: { roleId: role.id } });
    if (using) {
        throw new AppError(`${using} ${using === 1 ? 'person has' : 'people have'} this role. Give them another first.`, 409);
    }
    await prisma.role.delete({ where: { id: role.id } });
    res.status(204).end();
});

export default router;
