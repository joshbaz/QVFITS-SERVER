import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env } from '../env.mjs';

export const RATE_LIMITS = {
    api: { windowMinutes: 15, limit: 1500, keyedBy: 'signed-in user, otherwise IP' },
    login: { windowMinutes: 15, limit: 10, keyedBy: 'IP + email, failed attempts only' },
    loginPerIp: { windowMinutes: 15, limit: 60, keyedBy: 'IP, all attempts' },
};

const AUTH_PATH = /\/(login(\/[^/]+)?|request-password-reset|reset-password|register-superadmin)$/;

// ipKeyGenerator groups IPv6 addresses by subnet so a client can't rotate through them
const clientIp = (req) => ipKeyGenerator(req.ip || 'unknown');

// Key signed-in traffic per user so a whole campus behind one NAT IP is not throttled
// together. Unverifiable tokens fall back to the IP so random tokens can't dodge the limit.
const apiKey = (req) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (token) {
        try {
            const { id } = jwt.verify(token, env.AUTH_SECRET);
            if (id) return `user:${id}`;
        } catch {
            // fall through to IP
        }
    }
    return `ip:${clientIp(req)}`;
};

const rejected = (message) => (req, res) => {
    res.status(429).json({ status: 'error', message });
};

const minutes = (m) => m * 60 * 1000;

export const apiLimiter = rateLimit({
    windowMs: minutes(RATE_LIMITS.api.windowMinutes),
    limit: RATE_LIMITS.api.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: apiKey,
    handler: rejected('Too many requests. Please slow down and try again shortly.'),
});

const loginPerEmailLimiter = rateLimit({
    windowMs: minutes(RATE_LIMITS.login.windowMinutes),
    limit: RATE_LIMITS.login.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${clientIp(req)}:${String(req.body?.email || '').toLowerCase()}`,
    handler: rejected('Too many failed attempts. Please wait 15 minutes before trying again.'),
});

const loginPerIpLimiter = rateLimit({
    windowMs: minutes(RATE_LIMITS.loginPerIp.windowMinutes),
    limit: RATE_LIMITS.loginPerIp.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIp,
    handler: rejected('Too many sign-in attempts from this network. Please try again later.'),
});

/** Applies the strict limiters to login, registration and password-reset endpoints only. */
export const authLimiter = (req, res, next) => {
    const path = (req.originalUrl || '').split('?')[0];
    if (req.method !== 'POST' || !AUTH_PATH.test(path)) return next();
    loginPerIpLimiter(req, res, (err) => (err ? next(err) : loginPerEmailLimiter(req, res, next)));
};
