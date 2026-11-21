import crypto from 'crypto';

import prisma from '../../utils/db.mjs';
import { newRowId } from '../../utils/ids.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { applyPaid, paidSoFar, toShopperOrder } from '../sales/orders.mjs';
import { getStatus, isPesapalConfigured, PESAPAL_ENV, submitOrder } from './pesapal.mjs';

/**
 * Online payment through Pesapal, for orders paid by MTN MoMo, Airtel Money
 * or card. Each attempt is a transaction: pending while Pesapal's page is
 * open, keyed by Pesapal's order tracking id (its `reference`).
 *
 * Only Pesapal's own answer moves money on, never the browser and never the
 * IPN call itself: every path (the IPN, the shopper's return page, the
 * scheduler, the admin's Check) asks Pesapal and goes through `sync`. A
 * payment is only ever counted once, however many of those race.
 */

/** The methods Pesapal takes. WhatsApp orders are confirmed by hand, as before. */
export const ONLINE_METHODS = new Set(['mtn', 'airtel', 'card']);

const GATEWAY = `pesapal-${PESAPAL_ENV}`;
// Still open: a payment that failed or was abandoned can complete late, and is then counted.
const OPEN = ['pending', 'failed', 'abandoned'];
// The shopper's return page asks every few seconds; Pesapal is asked at most this often per payment.
const RECHECK_MS = 3_000;
const MINUTE = 60_000;

const money = (n) => `${n.toLocaleString('en-UG')} UGX`;
const save = (tx, data) => prisma.transaction.update({ where: { id: tx.id }, data });

/** Whether checkout opens Pesapal for this order: keys set and an online method. */
export const takesOnlinePayment = (order) => isPesapalConfigured() && ONLINE_METHODS.has(order.payment);

/** Recount what an order has been paid after a payment is taken back. */
const recount = async (order) => {
    const paid = await paidSoFar(order.id);
    const paymentStatus = paid >= order.total ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid';
    if (paymentStatus !== order.paymentStatus) await prisma.order.update({ where: { id: order.id }, data: { paymentStatus } });
};

/**
 * Bring one payment up to date with Pesapal and apply the answer.
 * @param {object} tx - A Transaction row
 * @param {{ by: string }} who - Named in the order's history when it becomes paid
 * @returns {Promise<{ outcome: string, message: string, transaction: object }>} `message` is written for staff
 */
const sync = async (tx, { by }) => {
    const reply = (outcome, message, transaction = tx) => ({ outcome, message, transaction });
    if (!tx.reference) return reply('unknown', 'This payment has no reference to check.');
    // Made with the other keys (sandbox and live see different payments): these can't look it up.
    if (tx.gateway && tx.gateway !== GATEWAY) {
        return reply('other_keys', `This payment was made with Pesapal's ${tx.gateway.replace('pesapal-', '')} keys and the shop now uses ${PESAPAL_ENV} ones, so it can't be looked up. Check it in that Pesapal dashboard.`);
    }
    const order = await prisma.order.findUnique({ where: { id: tx.orderId } });
    if (!order) return reply('unknown', 'The order for this payment no longer exists.');

    await save(tx, { checkedAt: new Date() });
    const answer = await getStatus(tx.reference);

    if (answer.state === 'unknown') return reply('unknown', `Pesapal doesn't recognise this payment${answer.note ? ` (${answer.note})` : ''}.`);
    // The tracking id belongs to another order: never count it here.
    if (tx.merchantRef && answer.reference && answer.reference !== tx.merchantRef) {
        console.error(`Payment ${tx.id}: Pesapal reports it for ${answer.reference}, not ${tx.merchantRef}; not counted`);
        return reply('unknown', `Pesapal has this payment under another reference (${answer.reference}), so it was not applied. Check it in the Pesapal dashboard.`);
    }

    if (answer.state === 'pending') {
        return reply('pending', tx.status === 'pending' ? 'Pesapal has no payment for this yet. It is still waiting.' : `Pesapal has no payment for this. It stays ${tx.status}.`);
    }

    if (answer.state === 'failed') {
        if (tx.status === 'succeeded') return reply('already', 'Pesapal reports this payment as failed, but it is already recorded as paid. Check it in the Pesapal dashboard.');
        const reason = answer.note || 'Declined at Pesapal';
        if (tx.status === 'failed' && tx.reason === reason) return reply('failed', `The payment failed: ${reason}`);
        return reply('failed', `The payment failed: ${reason}`, await save(tx, { status: 'failed', reason }));
    }

    if (answer.state === 'reversed') {
        if (tx.status === 'reversed') return reply('reversed', 'This payment was already recorded as reversed.');
        const was = tx.status;
        const saved = await save(tx, { status: 'reversed', reason: answer.note || 'Reversed at Pesapal' });
        if (was === 'succeeded') await recount(order);
        return reply('reversed', was === 'succeeded' ? `Pesapal reversed this payment, so order ${order.ref} is no longer paid in full.` : 'Pesapal reports this payment as reversed.', saved);
    }

    // Completed.
    if (tx.status === 'succeeded') return reply('already', 'This payment is already recorded as paid.');
    if (answer.currency && answer.currency !== 'UGX') {
        const reason = `Paid in ${answer.currency}, not UGX. Check the amount in the Pesapal dashboard.`;
        return reply('currency', `Pesapal took this payment in ${answer.currency}, so it was not applied to the order. Check it in the Pesapal dashboard.`, await save(tx, { reason }));
    }
    const amount = answer.amount > 0 ? Math.round(answer.amount) : tx.amount;
    // Claimed only while still open, so a second check, or the IPN, can't count it again.
    const claimed = await prisma.transaction.updateMany({
        where: { id: tx.id, status: { in: OPEN } },
        data: { status: 'succeeded', amount, reason: null, ...(answer.confirmationCode ? { note: `Pesapal ${answer.confirmationCode}` } : {}) },
    });
    const saved = await prisma.transaction.findUnique({ where: { id: tx.id } });
    if (!claimed.count) return reply('already', 'This payment was just recorded by another check.', saved);

    const current = await prisma.order.findUnique({ where: { id: order.id } });
    if (current.status === 'cancelled') {
        const withReason = await save(saved, { reason: 'Paid after the order was cancelled: refund it, or record the sale again.' });
        console.warn(`Order ${order.ref}: paid ${amount} UGX at Pesapal after it was cancelled`);
        return reply('late', `Pesapal took ${money(amount)}, but order ${order.ref} was already cancelled and its pieces went back on the shelf. Refund it, or record the sale again.`, withReason);
    }

    const paid = await paidSoFar(order.id);
    const full = paid >= current.total;
    await applyPaid(current, { full, method: tx.method, reference: answer.confirmationCode || tx.reference }, by);
    return reply(full ? 'paid' : 'part_paid', full ? `Paid: ${money(amount)} came in and order ${order.ref} is paid in full.` : `${money(amount)} came in. Order ${order.ref} still has ${money(current.total - paid)} to pay.`, saved);
};

/* Starting a payment */

/**
 * Open a Pesapal checkout for what is still due on an order, and record it
 * as a pending payment. An earlier attempt still open is marked abandoned
 * (it is still counted if it completes after all).
 * @returns {Promise<{ redirectUrl: string, trackingId: string }>}
 */
export const startPayment = async (order) => {
    if (!isPesapalConfigured()) throw new AppError('Online payment is not available just now. Message us on WhatsApp and we will help.', 503, { code: 'PAYMENTS_NOT_CONFIGURED' });
    if (!ONLINE_METHODS.has(order.payment)) throw new AppError('This order is paid by arrangement with the team, not online.', 409);
    if (order.status === 'cancelled') throw new AppError('This order was cancelled, so it can no longer be paid. You are welcome to order again.', 409);
    if (order.paymentStatus === 'paid') throw new AppError('This order is already paid.', 409);
    const due = order.total - (await paidSoFar(order.id));
    if (due <= 0) throw new AppError('This order is already paid.', 409);

    await prisma.transaction.updateMany({
        where: { orderId: order.id, type: 'payment', status: 'pending' },
        data: { status: 'abandoned', reason: 'Replaced by a new payment attempt' },
    });
    // Unique per attempt: Pesapal refuses a merchant reference it has seen before.
    const merchantRef = `${order.ref}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const { trackingId, redirectUrl } = await submitOrder({
        reference: merchantRef,
        amountUGX: due,
        description: `QVFITS order ${order.ref}`,
        // Pesapal adds ?OrderTrackingId=…&OrderMerchantReference=…; the page checks the payment from those.
        callbackUrl: `${env.APP_URL.replace(/\/+$/, '')}/order/${encodeURIComponent(order.ref)}/payment`,
        payer: { name: order.name, phone: order.phone, email: order.email },
    });
    await prisma.transaction.create({
        data: {
            id: newRowId('txn'),
            orderId: order.id,
            orderRef: order.ref,
            type: 'payment',
            method: order.payment,
            amount: due,
            status: 'pending',
            reference: trackingId,
            note: null,
            gateway: GATEWAY,
            merchantRef,
        },
    });
    return { redirectUrl, trackingId };
};

/**
 * Right after checkout: open Pesapal if this order takes online payment.
 * Never fails the order: if Pesapal can't be reached, the shopper is told and
 * can try again, or use the WhatsApp hand-off.
 * @returns {Promise<null | { redirectUrl: string } | { error: string }>}
 */
export const paymentForNewOrder = async (order) => {
    if (!takesOnlinePayment(order)) return null;
    try {
        const { redirectUrl } = await startPayment(order);
        return { redirectUrl };
    } catch (error) {
        console.error(`Order ${order.ref}: could not open Pesapal:`, error.message);
        return { error: "Your order is placed, but the payment page didn't open. Try paying again, or send your order on WhatsApp." };
    }
};

/* The shopper's side: the return page and paying again */

/** The shopper's own payment, by the order's reference and Pesapal's tracking id (both in the return address). */
const findShopperPayment = async (ref, trackingId) => {
    const tx = await prisma.transaction.findFirst({ where: { reference: trackingId, orderRef: ref, type: 'payment' } });
    if (!tx) throw new AppError('We could not find that payment.', 404);
    return tx;
};

const shopperView = async (tx) => {
    const order = await prisma.order.findUnique({ where: { id: tx.orderId } });
    return {
        // pending, succeeded, failed, abandoned or reversed; `paid` is the order's own word on it.
        status: tx.status,
        reason: tx.reason ?? null,
        paid: order?.paymentStatus === 'paid',
        order: order ? toShopperOrder(order) : null,
    };
};

/**
 * Where Pesapal sends the shopper back to. A payment not yet settled is
 * checked with Pesapal first (at most every few seconds).
 */
export const shopperPaymentStatus = async ({ ref, trackingId }) => {
    let tx = await findShopperPayment(ref, trackingId);
    const recent = tx.checkedAt && Date.now() - tx.checkedAt.getTime() < RECHECK_MS;
    if (OPEN.includes(tx.status) && !recent) {
        // Pesapal briefly unreachable: shown as it stands, and the page asks again.
        tx = (await sync(tx, { by: 'Pesapal' }).catch(() => null))?.transaction ?? tx;
    }
    return shopperView(tx);
};

/**
 * Pay again after a failed or abandoned attempt. The key is the order's
 * reference with either the last attempt's tracking id (the return page) or
 * the phone it was placed with (tracking an order).
 */
export const retryShopperPayment = async ({ ref, trackingId, phone }, findByRefAndPhone) => {
    const order = trackingId
        ? await prisma.order.findUnique({ where: { id: (await findShopperPayment(ref, trackingId)).orderId } })
        : await findByRefAndPhone(ref, phone);
    const { redirectUrl } = await startPayment(order);
    return { redirectUrl };
};

/* Pesapal's IPN */

/**
 * Pesapal's IPN names a payment whose status changed, and we ask Pesapal
 * what that change was (never trusting the call itself). The answer is the
 * JSON Pesapal expects; status 500 asks it to try again later.
 */
export const handleIpn = async ({ OrderTrackingId: trackingId, OrderMerchantReference: reference, OrderNotificationType: type }) => {
    const reply = (status) => ({ orderNotificationType: type ?? 'IPNCHANGE', orderTrackingId: trackingId ?? '', orderMerchantReference: reference ?? '', status });
    const tx = trackingId ? await prisma.transaction.findFirst({ where: { reference: trackingId, type: 'payment', gateway: { not: null } } }) : null;
    // Not ours (or not this one): acknowledged, so Pesapal stops sending it.
    if (!tx || (tx.merchantRef && reference && tx.merchantRef !== reference)) return reply(200);
    try {
        await sync(tx, { by: 'Pesapal' });
        return reply(200);
    } catch (error) {
        console.error(`IPN for ${reference ?? trackingId} failed:`, error.message);
        return reply(500);
    }
};

/* The scheduler and the unpaid hold */

/**
 * Ask Pesapal about online payments still open, in case an IPN never came:
 * pending ones from two minutes old (the shopper may still be on Pesapal's
 * page) and abandoned ones, which can still complete, for two days.
 * @returns {Promise<number>} how many came in
 */
export const checkOpenPayments = async () => {
    if (!isPesapalConfigured()) return 0;
    const now = Date.now();
    const open = await prisma.transaction.findMany({
        where: { type: 'payment', gateway: GATEWAY, status: { in: ['pending', 'abandoned'] }, createdAt: { lt: new Date(now - 2 * MINUTE), gt: new Date(now - 48 * 60 * MINUTE) } },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });
    let landed = 0;
    for (const tx of open) {
        const result = await sync(tx, { by: 'Pesapal' }).catch(() => null);
        if (['paid', 'part_paid', 'late'].includes(result?.outcome)) landed++;
    }
    return landed;
};

/**
 * A last word with Pesapal before an unpaid order's hold runs out, so a
 * payment made at the last minute is counted rather than cancelled.
 * @returns {Promise<boolean>} whether the order is still unpaid
 */
export const lastCheckBeforeExpiry = async (order) => {
    if (!isPesapalConfigured()) return true;
    const open = await prisma.transaction.findMany({ where: { orderId: order.id, type: 'payment', gateway: GATEWAY, status: 'pending' } });
    for (const tx of open) await sync(tx, { by: 'Pesapal' }).catch(() => null);
    if (!open.length) return true;
    const now = await prisma.order.findUnique({ where: { id: order.id } });
    return now?.status === 'pending' && now.paymentStatus === 'unpaid';
};

/* The admin's Check (Transactions) */

/**
 * Ask Pesapal about a payment now and apply its answer.
 * @returns {Promise<{ message: string, transaction: object }>}
 */
export const checkTransaction = async (reference, admin) => {
    if (!reference) throw new AppError('This payment has no reference to check.', 422);
    const tx = await prisma.transaction.findFirst({ where: { reference, type: 'payment' }, orderBy: { createdAt: 'desc' } });
    if (!tx) throw new AppError('No payment has that reference.', 404);
    if (!isPesapalConfigured()) throw new AppError('Online payments are not set up yet, so there is nothing to check with Pesapal.', 503, { code: 'PAYMENTS_NOT_CONFIGURED' });
    const { message, transaction } = await sync(tx, { by: `Pesapal (checked by ${admin.name})` });
    return { message, transaction };
};
