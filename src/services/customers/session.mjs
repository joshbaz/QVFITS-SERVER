import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import {
    CUSTOMER_PERSISTENT_TTL_MS,
    CUSTOMER_REFRESH_COOKIE,
    CUSTOMER_SESSION_TTL_MS,
    clearCustomerRefreshCookie,
    hashToken,
    randomToken,
    setCustomerRefreshCookie,
    signAccessToken,
} from '../../utils/tokens.mjs';

const REUSE_GRACE_MS = 30 * 1000;

const ended = () => new AppError('Your session has ended. Sign in again.', 401);

/** A customer as the shop sees them: never a password or token hash. */
export const publicCustomer = ({ passwordHash, confirmTokenHash, resetTokenHash, resetExpiresAt, phoneDigits, ...customer }) => customer;

/**
 * Sign a shopper in: a refresh token in an httpOnly cookie (kept for 30 days
 * when they stay signed in), and the access token plus their account in the body.
 */
export const startCustomerSession = async (res, customer, persistent) => {
    const token = randomToken();
    await prisma.customerSession.create({
        data: {
            tokenHash: hashToken(token),
            customerId: customer.id,
            persistent,
            expiresAt: new Date(Date.now() + (persistent ? CUSTOMER_PERSISTENT_TTL_MS : CUSTOMER_SESSION_TTL_MS)),
            // Stored as an explicit null: on MongoDB, `where: { revokedAt: null }` doesn't match a missing field.
            revokedAt: null,
        },
    });
    setCustomerRefreshCookie(res, token, persistent);
    return { customer: publicCustomer(customer), accessToken: signAccessToken(customer.id, 'customer') };
};

/** Every session of one shopper ends: password reset, closed account, or a reused refresh token. */
export const revokeCustomerSessions = (customerId) =>
    prisma.customerSession.updateMany({ where: { customerId, revokedAt: null }, data: { revokedAt: new Date() } });

/** Swap the refresh cookie for a new one, keeping "stay signed in" as it was. A copied token ends every session. */
export const rotateCustomerSession = async (req, res) => {
    const token = req.cookies?.[CUSTOMER_REFRESH_COOKIE];
    if (!token) throw ended();
    const stored = await prisma.customerSession.findUnique({ where: { tokenHash: hashToken(token) } });
    const fail = () => {
        clearCustomerRefreshCookie(res);
        return ended();
    };
    if (!stored) throw fail();
    if (stored.revokedAt) {
        // Two tabs share the cookie and can refresh at the same moment; only an old token counts as copied.
        if (Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) await revokeCustomerSessions(stored.customerId);
        throw fail();
    }
    const claimed = await prisma.customerSession.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!claimed.count || stored.expiresAt < new Date()) throw fail();

    const customer = await prisma.customer.findUnique({ where: { id: stored.customerId } });
    if (!customer) throw fail();
    return startCustomerSession(res, customer, stored.persistent);
};

export const endCustomerSession = async (req, res) => {
    const token = req.cookies?.[CUSTOMER_REFRESH_COOKIE];
    if (token) await prisma.customerSession.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
    clearCustomerRefreshCookie(res);
};
