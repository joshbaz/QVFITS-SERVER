import { createClient } from 'redis';
import { env } from '../env.mjs';

const STARTUP_TIMEOUT_MS = 10 * 1000;
const COMMAND_TIMEOUT_MS = 1000;

/**
 * The shared Redis connection. Today it holds the rate-limit counters, so
 * every PM2 process counts against the same limit and a restart doesn't
 * reset them. Job queues and the Socket.IO adapter can share it later.
 */
export const redis = createClient({
    url: env.REDIS_URL,
    // Keep trying after an outage, backing off to one attempt every 5 seconds.
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
});

// The client reports every failed reconnect; one line per outage is enough.
let down = false;
redis.on('error', (error) => {
    if (down) return;
    down = true;
    // A refused connection is an AggregateError with no message, only a code.
    console.error('Redis unavailable:', error.message || error.code || error.name);
});
redis.on('ready', () => {
    if (down) console.info('Redis reconnected');
    down = false;
});

/** Connect at start-up. A server that can't reach Redis within 10 seconds stops, like one without its database. */
export const connectRedis = async () => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Could not reach Redis at ${env.REDIS_URL}`)), STARTUP_TIMEOUT_MS);
    });
    try {
        await Promise.race([redis.connect(), timeout]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Send a raw command, failing fast while Redis is down instead of waiting in
 * the client's offline queue. The rate limiters use this so an outage lets
 * requests through (and is logged) rather than freezing every sign-in.
 * @param {string[]} args
 */
export const sendCommand = (args) => {
    if (!redis.isReady) return Promise.reject(new Error('Redis is not connected'));
    let timer;
    return Promise.race([
        redis.sendCommand(args),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Redis command timed out')), COMMAND_TIMEOUT_MS);
        }),
    ]).finally(() => clearTimeout(timer));
};
