import prisma from '../utils/db.mjs';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/tokens.mjs';

/** The signed-in shopper from a customer-realm token, or null. An admin token is never a shopper. */
const customerFrom = async (req) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const payload = token ? verifyAccessToken(token) : null;
    if (!payload?.id || payload.realm !== 'customer') return null;
    return prisma.customer.findUnique({ where: { id: payload.id } });
};

/** Require a signed-in shopper; sets req.customer (the full record). */
export const requireCustomer = async (req, res, next) => {
    const customer = await customerFrom(req);
    if (!customer) return next(new AppError('Your session has ended. Sign in again.', 401));
    req.customer = customer;
    next();
};

/**
 * Checkout works for guests too: a valid shopper token links the order to the
 * account, and anything else (no token, an expired one) checks out as a guest.
 */
export const optionalCustomer = async (req, res, next) => {
    req.customer = await customerFrom(req);
    next();
};
