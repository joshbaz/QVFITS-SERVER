import crypto from 'crypto';
import { redis } from '../utils/redis.mjs';
import { expireUnpaid } from '../services/sales/orders.mjs';
import { sendDueCampaigns } from '../services/newsletter/campaigns.mjs';
import { removeUnusedUploads } from '../services/media/cleanup.mjs';

const MINUTE = 60 * 1000;

/**
 * The shop's background tasks. Each runs on its own interval behind a Redis
 * lock held a little under that interval, so with several PM2 processes only
 * one runs a task at a time and the rest skip that round.
 */
const TASKS = [
    // Unpaid orders past their hold are cancelled and their stock goes back.
    { name: 'expire-unpaid', every: 5 * MINUTE, run: expireUnpaid, done: (n) => n && `Expired ${n} unpaid order${n === 1 ? '' : 's'}` },
    // Scheduled newsletter campaigns whose time has come are sent.
    { name: 'send-campaigns', every: MINUTE, run: sendDueCampaigns, done: (n) => n && `Sent ${n} scheduled campaign${n === 1 ? '' : 's'}` },
    // Uploaded photos nothing uses any more (and over a week old) are deleted from ImageKit.
    { name: 'remove-unused-uploads', every: 24 * 60 * MINUTE, run: removeUnusedUploads, done: (n) => n && `Removed ${n} unused upload${n === 1 ? '' : 's'} from ImageKit` },
];

const timers = [];

const runTask = async (task) => {
    try {
        const got = await redis.set(`qvfits:lock:${task.name}`, crypto.randomUUID(), { NX: true, PX: task.every - 5_000 });
        if (got !== 'OK') return;
        const message = task.done(await task.run());
        if (message) console.info(message);
    } catch (error) {
        console.error(`Task ${task.name} failed:`, error.message);
    }
};

const schedule = (task) => {
    runTask(task);
    const timer = setInterval(() => runTask(task), task.every);
    timer.unref?.();
    timers.push(timer);
};

export const startScheduler = () => {
    if (timers.length) return;
    TASKS.forEach(schedule);
};
