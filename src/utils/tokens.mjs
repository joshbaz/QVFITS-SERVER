import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.mjs';

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ADMIN_REFRESH_COOKIE = 'qvfits_admin_rt';
// The cookie only travels to the admin auth routes, never to the rest of the API.
const ADMIN_REFRESH_PATH = '/api/v1/auth/admin';

/** A short-lived JWT. `realm` keeps an admin token from working on customer routes and back. */
export const signAccessToken = (id, realm) =>
    jwt.sign({ id, realm }, env.AUTH_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

/** @returns {{ id: string, realm: string } | null} */
export const verifyAccessToken = (token) => {
    try {
        return jwt.verify(token, env.AUTH_SECRET);
    } catch {
        return null;
    }
};

/** A random token for refresh cookies and invite links. Only its hash is stored. */
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// No maxAge: a session cookie, so the admin session ends with the browser.
const adminCookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: ADMIN_REFRESH_PATH,
};

export const setAdminRefreshCookie = (res, token) => res.cookie(ADMIN_REFRESH_COOKIE, token, adminCookieOptions);

export const clearAdminRefreshCookie = (res) => res.clearCookie(ADMIN_REFRESH_COOKIE, adminCookieOptions);
