import express from "express";
import http from 'http';
import { env } from './env.mjs';
import customizeApp from './app.mjs';
import { setupSocketIO } from './utils/sockets.js';

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
    customizeApp(app);



    const server = http.createServer(app);

    setupSocketIO(server, app);

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


