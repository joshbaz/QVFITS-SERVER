import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import jwt from 'jsonwebtoken';
import { env } from '../env.mjs';
import { sendCommand } from './redis.mjs';

export const RATE_LIMITS = {
    api: { windowMinutes: 15, limit: 1500, keyedBy: 'signed-in user, otherwise IP' },
    login: { windowMinutes: 15, limit: 10, keyedBy: 'IP + email, failed attempts only' },
    loginPerIp: { windowMinutes: 15, limit: 60, keyedBy: 'IP, all attempts' },
    forms: { windowMinutes: 60, limit: 10, keyedBy: 'IP' },
};

// Public forms anyone can send without signing in: reviews now, contact and newsletter later.
const FORM_PATH = /\/catalog\/reviews$/;

// Sign-in and every public form that takes a password or creates an account.
const AUTH_PATH = /\/auth\/(admin|customer)\/(login|setup|accept-invite|signup|forgot-password|reset-password)$/;

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
    res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
};

const minutes = (m) => m * 60 * 1000;

/**
 * One limiter with its own Redis counters (prefix), so every PM2 process
 * shares the count and a restart doesn't hand out a fresh allowance. If Redis
 * is down the request is let through and the outage logged (passOnStoreError),
 * rather than locking everyone out of signing in.
 */
const limiter = (prefix, { windowMinutes, limit }, options) => rateLimit({
    windowMs: minutes(windowMinutes),
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({ prefix: `qvfits:rl:${prefix}:`, sendCommand: (...args) => sendCommand(args) }),
    ...options,
});

/**
 * Build the limiters once Redis is connected (the stores load a script into
 * Redis as they are made). Returns the general API limiter and the strict one
 * for sign-in, registration and password reset.
 */
export const createRateLimiters = () => {
    const apiLimiter = limiter('api', RATE_LIMITS.api, {
        keyGenerator: apiKey,
        handler: rejected('Too many requests. Please slow down and try again shortly.'),
    });

    const loginPerEmailLimiter = limiter('login-email', RATE_LIMITS.login, {
        skipSuccessfulRequests: true,
        keyGenerator: (req) => `${clientIp(req)}:${String(req.body?.email || '').toLowerCase()}`,
        handler: rejected('Too many failed attempts. Please wait 15 minutes before trying again.'),
    });

    const loginPerIpLimiter = limiter('login-ip', RATE_LIMITS.loginPerIp, {
        keyGenerator: clientIp,
        handler: rejected('Too many sign-in attempts from this network. Please try again later.'),
    });

    /** Applies the strict limiters to login, registration and password-reset endpoints only. */
    const authLimiter = (req, res, next) => {
        const path = (req.originalUrl || '').split('?')[0];
        if (req.method !== 'POST' || !AUTH_PATH.test(path)) return next();
        loginPerIpLimiter(req, res, (err) => (err ? next(err) : loginPerEmailLimiter(req, res, next)));
    };

    const formsPerIpLimiter = limiter('forms', RATE_LIMITS.forms, {
        keyGenerator: clientIp,
        handler: rejected('Thanks, we have plenty from you for now. Please try again later.'),
    });

    /** Applies the forms limiter to public form posts only. */
    const formsLimiter = (req, res, next) => {
        const path = (req.originalUrl || '').split('?')[0];
        if (req.method !== 'POST' || !FORM_PATH.test(path)) return next();
        formsPerIpLimiter(req, res, next);
    };

    return { apiLimiter, authLimiter, formsLimiter };
};
