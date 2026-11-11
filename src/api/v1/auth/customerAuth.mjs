import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { env } from '../../../env.mjs';
import { AppError } from '../../../utils/AppError.js';
import { newRowId, normalEmail, phoneDigits } from '../../../utils/ids.mjs';
import { hashToken, randomToken } from '../../../utils/tokens.mjs';
import validate from '../../../middleware/validate.mjs';
import { requireCustomer } from '../../../middleware/customerAuth.mjs';
import { queueEmail } from '../../../services/notify/outbox.mjs';
import {
    endCustomerSession, publicCustomer, revokeCustomerSessions, rotateCustomerSession, startCustomerSession,
} from '../../../services/customers/session.mjs';

/**
 * Shopper accounts: sign up, sign in, stay signed in, confirm the email, reset
 * the password. The emails wait in the outbox until an email service is
 * connected; outside production the link also comes back in the response, so
 * the flows can be tried without one.
 */
const router = express.Router();

const BCRYPT_ROUNDS = 12;
const HOUR = 60 * 60 * 1000;
// A second reset request within a minute is ignored, so the form can't flood someone's inbox.
const RESET_COOLDOWN_MS = 60 * 1000;
// A form sent faster than a person could fill it in is a bot.
const MIN_FILL_MS = 1200;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);
const showLinks = env.NODE_ENV !== 'production';

const email = z.string({ error: 'Enter your email' }).trim().toLowerCase().email('Enter a valid email');
const newPassword = z.string({ error: 'Choose a password' }).min(8, 'Use at least 8 characters.').max(72, 'At most 72 characters');
// The public forms' bot check: a hidden field people never fill in, and when the form appeared.
const guard = z.object({ hp: z.string().max(200).optional(), startedAt: z.number().optional() }).optional();

const assertHuman = (g) => {
    if (!g) return;
    if (g.hp) throw new AppError('Something went wrong. Please try again.', 422);
    if (g.startedAt && Date.now() - g.startedAt < MIN_FILL_MS) throw new AppError('That was quick. Please try again.', 429);
};

/**
 * Orders placed as a guest with the same email or phone join the account, so
 * a shopper who signs up later sees everything they bought.
 */
export const claimGuestOrders = async (customer) => {
    const or = [{ email: { equals: customer.email, mode: 'insensitive' } }];
    if (customer.phoneDigits) or.push({ phoneDigits: customer.phoneDigits });
    await prisma.order.updateMany({ where: { customerId: null, OR: or }, data: { customerId: customer.id } });
    await prisma.returnRequest.updateMany({
        where: { customerId: null, orderId: { in: (await prisma.order.findMany({ where: { customerId: customer.id }, select: { id: true } })).map((o) => o.id) } },
        data: { customerId: customer.id },
    });
};

// The sign-up email's link carries a one-time token; the address counts as theirs once it is opened.
const sendConfirm = async (customer) => {
    const token = randomToken();
    await prisma.customer.update({ where: { id: customer.id }, data: { confirmTokenHash: hashToken(token) } });
    const link = `${env.APP_URL}/account/confirm?token=${token}`;
    await queueEmail({ to: customer.email, kind: 'account-confirm', subject: 'Confirm your QVFITS account', body: `Hi ${customer.name.split(' ')[0]}, tap to confirm this is your email.`, link });
    return link;
};

const withSession = async (res, customer, remember, extra = {}) => ({ ...(await startCustomerSession(res, customer, remember)), ...extra });

router.post('/signup', validate(z.object({
    name: z.string({ error: 'Enter your name' }).trim().min(1, 'Enter your name').max(80),
    email,
    password: newPassword,
    phone: z.string().trim().max(30).optional(),
    remember: z.boolean().optional(),
    guard,
})), async (req, res) => {
    const { name, email: address, password, phone, remember = true } = req.body;
    assertHuman(req.body.guard);
    if (await prisma.customer.findUnique({ where: { email: address } })) {
        throw new AppError('An account with that email already exists. Sign in instead.', 409);
    }
    // One account per phone, so order history and one-per-shopper codes stay with one person.
    const digits = phone ? phoneDigits(phone) : null;
    if (digits && await prisma.customer.findFirst({ where: { phoneDigits: digits } })) {
        throw new AppError('An account already uses that phone number. Sign in, or reset its password.', 409);
    }

    const customer = await prisma.customer.create({
        data: {
            id: newRowId('cus'), name, email: address, phone: phone || null, phoneDigits: digits,
            passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
            addresses: [], wishlist: [], bag: [], recentlyViewed: [], tags: [],
            emailConfirmedAt: null, confirmTokenHash: null, resetTokenHash: null, resetExpiresAt: null,
        },
    });
    await claimGuestOrders(customer);
    const link = await sendConfirm(customer);
    res.status(201).json({ data: await withSession(res, customer, remember, showLinks ? { devLink: link } : {}) });
});

router.post('/login', validate(z.object({ email, password: z.string({ error: 'Enter your password' }).min(1, 'Enter your password').max(200), remember: z.boolean().optional() })), async (req, res) => {
    const { email: address, password, remember = true } = req.body;
    const customer = await prisma.customer.findUnique({ where: { email: address } });
    const matches = await bcrypt.compare(password, customer?.passwordHash ?? DUMMY_HASH);
    // One message for an unknown email and a wrong password, so neither reveals who shops here.
    if (!customer || !matches) throw new AppError('Email or password is incorrect.', 401, { code: 'INVALID_CREDENTIALS' });
    await claimGuestOrders(customer);
    res.json({ data: await withSession(res, customer, remember) });
});

router.post('/refresh', async (req, res) => {
    res.json({ data: await rotateCustomerSession(req, res) });
});

router.post('/logout', async (req, res) => {
    await endCustomerSession(req, res);
    res.status(204).end();
});

router.get('/me', requireCustomer, (req, res) => {
    res.json({ data: publicCustomer(req.customer) });
});

/** The sign-up email's link: the address is theirs. */
router.post('/confirm-email', validate(z.object({ token: z.string().min(1).max(200) })), async (req, res) => {
    const customer = await prisma.customer.findFirst({ where: { confirmTokenHash: hashToken(req.body.token) } });
    if (!customer) throw new AppError("That link isn't valid any more. Sign in and we'll send a new one.", 404);
    const updated = await prisma.customer.update({ where: { id: customer.id }, data: { emailConfirmedAt: new Date(), confirmTokenHash: null } });
    res.json({ data: publicCustomer(updated) });
});

/**
 * A reset link by email, valid for an hour. The answer is the same whether or
 * not the address has an account, so nobody can use the form to find out who shops here.
 */
router.post('/forgot-password', validate(z.object({ email, guard })), async (req, res) => {
    assertHuman(req.body.guard);
    const address = normalEmail(req.body.email);
    const customer = await prisma.customer.findUnique({ where: { email: address } });
    let link;
    const cooling = customer?.resetExpiresAt && customer.resetExpiresAt.getTime() - HOUR + RESET_COOLDOWN_MS > Date.now();
    if (customer && !cooling) {
        const token = randomToken();
        await prisma.customer.update({ where: { id: customer.id }, data: { resetTokenHash: hashToken(token), resetExpiresAt: new Date(Date.now() + HOUR) } });
        link = `${env.APP_URL}/reset-password?token=${token}`;
        await queueEmail({ to: customer.email, kind: 'password-reset', subject: 'Reset your QVFITS password', body: "Tap to choose a new password. The link works for an hour. If you didn't ask, ignore this email.", link });
    }
    res.json({ data: { sent: true, email: address, ...(showLinks && link ? { devLink: link } : {}) } });
});

// A used or expired link is refused with a 410; a reset burns the token and signs out every device.
router.post('/reset-password', validate(z.object({ token: z.string().min(1).max(200), password: newPassword })), async (req, res) => {
    const customer = await prisma.customer.findFirst({ where: { resetTokenHash: hashToken(req.body.token) } });
    if (!customer || !customer.resetExpiresAt || customer.resetExpiresAt < new Date()) throw new AppError('That link has expired. Ask for a new one.', 410);
    const claimed = await prisma.customer.updateMany({
        where: { id: customer.id, resetTokenHash: customer.resetTokenHash },
        data: { passwordHash: await bcrypt.hash(req.body.password, BCRYPT_ROUNDS), resetTokenHash: null, resetExpiresAt: null },
    });
    if (!claimed.count) throw new AppError('That link has expired. Ask for a new one.', 410);
    await revokeCustomerSessions(customer.id);
    res.json({ data: { email: customer.email } });
});

export default router;
