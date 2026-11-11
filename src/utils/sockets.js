import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis } from './redis.mjs';
import { corsOptions } from './corsOptions.js';
import { verifyAccessToken } from './tokens.mjs';

let io = null;

/**
 * Live updates over Socket.IO. A connection must carry an access token (the
 * same one the API takes): staff join the `admin` room, a shopper their own
 * `customer:<id>` room. Nobody else can connect, so nothing is ever pushed to
 * a stranger. The Redis adapter carries each event to every PM2 process, so
 * it reaches a browser whichever process it is connected to.
 * @param {import('http').Server} server
 * @param {import('express').Application} app
 * @returns {Promise<Server>}
 */
export const setupSocketIO = async (server, app) => {
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    // Without a listener, a Redis outage would crash the process; the main client already logs it.
    for (const client of [pub, sub]) client.on('error', () => {});
    await Promise.all([pub.connect(), sub.connect()]);
    io = new Server(server, {
        cors: { origin: corsOptions.origin, credentials: corsOptions.credentials },
        adapter: createAdapter(pub, sub),
    });

    // The token is checked once, when the socket connects; a token that expires later keeps the socket until it drops.
    io.use((socket, next) => {
        const payload = verifyAccessToken(socket.handshake.auth?.token ?? '');
        if (!payload?.id || !['admin', 'customer'].includes(payload.realm)) return next(new Error('Sign in first.'));
        socket.data.realm = payload.realm;
        socket.data.id = payload.id;
        next();
    });

    io.on('connection', (socket) => {
        socket.join(socket.data.realm === 'admin' ? 'admin' : `customer:${socket.data.id}`);
    });

    app.set('io', io);
    return io;
};

/** Tell every signed-in admin something happened (a new order, say). Quietly does nothing before start-up. */
export const toAdmins = (event, payload) => io?.to('admin').emit(event, payload);

/** Tell one shopper about their own order. */
export const toCustomer = (customerId, event, payload) => {
    if (customerId) io?.to(`customer:${customerId}`).emit(event, payload);
};
