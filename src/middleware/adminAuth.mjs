import prisma from '../utils/db.mjs';
import { AppError } from '../utils/AppError.js';
import { can, toAdminUser } from '../utils/permissions.mjs';
import { verifyAccessToken } from '../utils/tokens.mjs';

/**
 * Require a signed-in admin. The person and their role are read fresh on every
 * request, so a suspension or a role change applies at once, not when the token expires.
 * Sets req.admin (the AdminUser the client sees) and req.staff (the record).
 */
export const requireAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const payload = token ? verifyAccessToken(token) : null;
    // A customer token is refused here even though its signature is valid.
    if (!payload?.id || payload.realm !== 'admin') {
        return next(new AppError('Your session has ended. Sign in again.', 401));
    }

    const staff = await prisma.staff.findUnique({ where: { id: payload.id }, include: { role: true } });
    if (!staff || staff.status !== 'active') {
        return next(new AppError('Your session has ended. Sign in again.', 401));
    }

    req.staff = staff;
    req.admin = toAdminUser(staff, staff.role);
    next();
};

/**
 * Require a permission, after requireAdmin: requirePermission('team', 'edit').
 * @param {string} module - A module id from src/data/permissions.json
 * @param {string} [action]
 */
export const requirePermission = (module, action = 'view') => (req, res, next) => {
    if (!can(req.admin, module, action)) {
        return next(new AppError('Your role does not allow this. Ask the owner for access.', 403));
    }
    next();
};
