import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { toAdminUser } from '../../../utils/permissions.mjs';
import {
    ADMIN_REFRESH_COOKIE,
    REFRESH_TOKEN_TTL_MS,
    clearAdminRefreshCookie,
    hashToken,
    randomToken,
    setAdminRefreshCookie,
    signAccessToken,
} from '../../../utils/tokens.mjs';

const REUSE_GRACE_MS = 30 * 1000;

const ended = () =>new AppError('Your session has ended. Sign in again.', 401);

/**
 * Sign a staff member in: a refresh token in an httpOnly cookie, and the
 * access token plus AdminUser in the body for the client to keep in the tab.
 * @param {import('express').Response} res
 * @param {{ id: string, roleId: string }} staff
 * @param {object} role
 */
export const startSession = async (res, staff, role) => {
    const refreshToken = randomToken();
    await prisma.refreshToken.create({
        data: {
            tokenHash: hashToken(refreshToken),
            staffId: staff.id,
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            // Stored as an explicit null: on MongoDB, `where: { revokedAt: null }` doesn't match a missing field.
            revokedAt: null,
        },
    });
    setAdminRefreshCookie(res, refreshToken);
    return { admin: toAdminUser(staff, role), accessToken: signAccessToken(staff.id, 'admin') };
};

/**
 * Swap the refresh cookie for a new one and a new access token. A token that
 * was already used means it was copied: every session for that person ends.
 */
export const rotateSession = async (req, res) => {
    const token = req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!token) throw ended();

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored) {
        clearAdminRefreshCookie(res);
        throw ended();
    }
    if (stored.revokedAt) {
        // Two tabs share the cookie and can refresh at the same moment; only an old token counts as copied.
        if (Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) await revokeAllSessions(stored.staffId);
        clearAdminRefreshCookie(res);
        throw ended();
    }
    // Claim the token before issuing a new one, so two refreshes racing with it can't both win.
    const claimed = await prisma.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    if (!claimed.count || stored.expiresAt < new Date()) {
        clearAdminRefreshCookie(res);
        throw ended();
    }

    const staff = await prisma.staff.findUnique({ where: { id: stored.staffId }, include: { role: true } });
    if (!staff || staff.status !== 'active') {
        clearAdminRefreshCookie(res);
        throw ended();
    }
    return startSession(res, staff, staff.role);
};

/** End the session the cookie belongs to, if there is one. */
export const endSession = async (req, res) => {
    const token = req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (token) {
        await prisma.refreshToken.updateMany({
            where: { tokenHash: hashToken(token), revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }
    clearAdminRefreshCookie(res);
};

/** Sign a person out everywhere: on suspension, removal, or a reused refresh token. */
export const revokeAllSessions = (staffId) =>
    prisma.refreshToken.updateMany({ where: { staffId, revokedAt: null }, data: { revokedAt: new Date() } });
