import express from "express";
import http from 'http';
import { env } from './env.mjs';
import customizeApp from './app.mjs';
import { setupSocketIO } from './utils/sockets.js';
import { ensureSystemRoles } from './utils/permissions.mjs';
import { connectRedis } from './utils/redis.mjs';
import { startScheduler } from './jobs/scheduler.mjs';
import { startEmailWorker } from './services/emails/queue.mjs';
import { isMailConfigured } from './services/emails/zohoMail.js';

const app = express();


app.start = async () => {
    console.log("Starting server...");
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
    signals.forEach(signal => {
        process.on(signal, () => {
            console.log(`Received ${signal}, shutting down...`);
            process.exit();
        });
    });

    const port = env.PORT;
    app.set('port', port);
    // The rate limiters keep their counters in Redis, so it must be reachable before the app is built.
    await connectRedis();
    customizeApp(app);

    // Owner, Manager and Staff must exist before anyone can be invited to one.
    await ensureSystemRoles();



    const server = http.createServer(app);

    await setupSocketIO(server, app);

    server.on("error", (error) => {
        if (error.syscall !== 'listen') {
            throw error;
        }
        console.error('Failed to start server', error);
        process.exit(1);
    });

    server.on("listening", () => {
        const addr = server.address();
        const bind =
            typeof addr === 'string' ? `pipe ${addr}` : `port ${addr?.port}`;
        console.log(`Server listening on ${bind}`);
        console.info('Server started ✅');

        // Background tasks: unpaid orders expire, scheduled campaigns go out.
        startScheduler();

        // Emails go out through Zoho Mail once a mailbox is set up; until then they wait in the Outbox.
        startEmailWorker();
        if (!isMailConfigured()) console.info('Email: no Zoho mailbox set up, so emails stay in the Outbox');
    });

    if (env.NODE_ENV !== 'test') {
        server.listen(port);
    }
}

Promise.resolve(true).then(app.start).catch((err) => {
    console.error(err);
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

export default app;


