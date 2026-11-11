import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { isMailConfigured, sendMail } from './zohoMail.js';
import { renderEmail } from './templates.mjs';

/**
 * The email queue: every Outbox row is handed to a BullMQ job on Redis and
 * sent through Zoho Mail by one worker. A failed send is retried five times,
 * waiting longer each time (30s, 1m, 2m, 4m, 8m); the Outbox row shows what
 * happened. Zoho Mail limits how much a mailbox sends, so the worker sends at
 * most 20 a minute.
 */

const QUEUE = 'qvfits-emails';
const ATTEMPTS = 5;
// BullMQ runs on ioredis with its own connections (a worker blocks on one while it waits for jobs).
// The producer fails fast while Redis is down, so queueing an email never hangs a shopper's request.
const connection = ({ failFast = false } = {}) => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: !failFast });
const CATCH_UP_MS = 10 * 60 * 1000;

let queue = null;
let worker = null;

const looksLikeEmail = (to) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);

/**
 * Put an Outbox row on the queue. With no Zoho mailbox set up the row is
 * held (kept in the Outbox, not sent); a row addressed to a phone number is
 * marked no_email for staff to send on WhatsApp.
 */
export const enqueueEmail = async (row) => {
    if (!looksLikeEmail(row.to)) {
        return prisma.outboxEmail.update({ where: { id: row.id }, data: { status: 'no_email', error: 'Only a phone number; send it on WhatsApp.' } });
    }
    if (!isMailConfigured()) return prisma.outboxEmail.update({ where: { id: row.id }, data: { status: 'held' } });
    queue ??= new Queue(QUEUE, { connection: connection({ failFast: true }) });
    await queue.add('send', { id: row.id }, {
        // The row id as the job id, so one email can never be queued twice.
        jobId: row.id,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
    });
    return row;
};

/** Send one Outbox row; a throw tells BullMQ to retry it. */
const deliver = async (job) => {
    const row = await prisma.outboxEmail.findUnique({ where: { id: job.data.id } });
    if (!row || row.status === 'sent') return;
    try {
        const { html, text } = renderEmail(row);
        await sendMail({ to: row.to, subject: row.subject, text, html });
        await prisma.outboxEmail.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), attempts: job.attemptsMade + 1, error: null } });
    } catch (error) {
        const last = job.attemptsMade + 1 >= ATTEMPTS;
        await prisma.outboxEmail.update({
            where: { id: row.id },
            data: { status: last ? 'failed' : 'queued', attempts: job.attemptsMade + 1, error: String(error.message).slice(0, 300) },
        });
        throw error;
    }
};

/** Start the one worker. Every PM2 process may run one; BullMQ hands each job to only one of them. */
export const startEmailWorker = () => {
    if (worker || !isMailConfigured()) return;
    worker = new Worker(QUEUE, deliver, { connection: connection(), concurrency: 1, limiter: { max: 20, duration: 60_000 } });
    worker.on('failed', (job, error) => console.error(`Email ${job?.data?.id} failed (attempt ${job?.attemptsMade}):`, error.message));
    catchUp();
    setInterval(catchUp, CATCH_UP_MS).unref?.();
};

/**
 * Anything still waiting to send (queued while Redis was down, or before a
 * restart) goes on the queue again. The job id is the row id, so an email
 * already on the queue isn't added twice.
 */
const catchUp = async () => {
    try {
        const waiting = await prisma.outboxEmail.findMany({ where: { status: 'queued' }, take: 500 });
        for (const row of waiting) await enqueueEmail(row);
    } catch (error) {
        console.error('Email catch-up skipped:', error.message);
    }
};

/** Send again an email that gave up or was held, for the Outbox's "Try again". */
export const retryEmail = async (id) => {
    const row = await prisma.outboxEmail.update({ where: { id }, data: { status: 'queued', error: null, attempts: 0 } });
    if (queue) await queue.remove(id).catch(() => {});
    return enqueueEmail(row);
};
