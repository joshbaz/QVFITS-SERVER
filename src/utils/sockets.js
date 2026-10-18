import { Server } from 'socket.io';
import { corsOptions } from './corsOptions.js';

/**
 * Attach a Socket.IO server to the HTTP server and expose it as app.get('io').
 * @param {import('http').Server} server
 * @param {import('express').Application} app
 * @returns {Server}
 */
export const setupSocketIO = (server, app) => {
    const io = new Server(server, {
        cors: { origin: corsOptions.origin, credentials: corsOptions.credentials },
    });

    io.on('connection', (socket) => {
        socket.on('disconnect', () => {});
    });

    app.set('io', io);
    return io;
};
