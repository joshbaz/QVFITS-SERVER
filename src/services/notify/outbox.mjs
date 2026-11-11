import prisma from '../../utils/db.mjs';
import { enqueueEmail } from '../emails/queue.mjs';
import { toCustomer } from '../../utils/sockets.js';

/**
 * Every email the shop sends: order updates, account confirmations, password
 * resets, invites, low-stock alerts. Each is written to the Outbox (staff see
 * it there and on its order) and handed to the email queue, which sends it
 * through Zoho Mail. Queueing never fails the request that asked for it: if
 * Redis is down for a moment, the row stays queued and is picked up later.
 */
export const queueEmail = async ({ to, kind, subject, body, link = null, ref = null, unsubscribe = null, meta = null }) => {
    const row = await prisma.outboxEmail.create({
        data: { to, kind, subject, body, link, ref, unsubscribe, meta, status: 'queued', attempts: 0, error: null, sentAt: null },
    });
    try {
        return await enqueueEmail(row);
    } catch (error) {
        console.error('Email not queued yet:', error.message);
        return row;
    }
};

const STATUS_WORDS = {
    paid: "We have your payment, thank you. We're getting it ready.",
    packed: 'Your order is packed and waiting for the rider.',
    out_for_delivery: 'Your order is on its way to you today.',
    delivered: 'Your order was delivered. Enjoy it, and tell us how it fits.',
    cancelled: 'Your order was cancelled, and nothing more is owed.',
    refunded: 'Your refund is on its way back to you.',
};

/** Tells the customer their order moved; staff can also send the same words on WhatsApp. */
export const notifyCustomer = (order, status, extra = '') => {
    // A signed-in shopper's open order page refreshes itself.
    toCustomer(order.customerId, 'order:updated', { id: order.id, ref: order.ref, status });
    const words = STATUS_WORDS[status];
    if (!words) return null;
    return queueEmail({
        to: order.email || order.phone,
        kind: 'order-update',
        ref: order.ref,
        subject: `Order ${order.ref}: ${status.replace(/_/g, ' ')}`,
        body: `${words}${extra ? ` ${extra}` : ''}`,
        // The track page fills the reference in from the link; the shopper adds their phone.
        link: `/track-order?ref=${encodeURIComponent(order.ref)}`,
    });
};
