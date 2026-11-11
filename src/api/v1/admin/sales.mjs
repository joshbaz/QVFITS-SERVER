import crypto from 'crypto';
import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { can } from '../../../utils/permissions.mjs';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { publicCustomer } from '../../../services/customers/session.mjs';
import { eraseCustomer } from '../../../services/customers/privacy.mjs';
import { notifyCustomer } from '../../../services/notify/outbox.mjs';
import { retryEmail } from '../../../services/emails/queue.mjs';
import {
    NEXT_STATUS, cancelOrder, expireUnpaid, paidSoFar, placeOrder, recordTransaction, settlePayment, toOrder,
} from '../../../services/sales/orders.mjs';
import { createReturn, refundDue, toReturn, updateReturnStatus } from '../../../services/sales/returns.mjs';
import { checkoutSchema, returnInput } from '../checkout/schemas.mjs';

/**
 * Orders, returns, money, the outbox and customers for the admin. Moving
 * money needs its own permissions: `payment` to record what came in,
 * `refund` to give it back.
 */
const router = express.Router();
router.use(requireAdmin);

const forbid = () => new AppError('Your role does not allow this. Ask the owner for access.', 403);
const findOrder = async (id) => {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError('That order no longer exists.', 404);
    return order;
};
const method = z.string().min(1, 'Pick how it was paid.').max(40);

/* Orders */

router.get('/orders', requirePermission('orders', 'view'), async (req, res) => {
    await expireUnpaid();
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: orders.map(toOrder) });
});

/** The messages sent to the customer about one order, oldest first. */
router.get('/orders/emails/:ref', requirePermission('orders', 'view'), async (req, res) => {
    res.json({ data: await prisma.outboxEmail.findMany({ where: { ref: req.params.ref }, orderBy: { createdAt: 'asc' } }) });
});

router.get('/orders/:id', requirePermission('orders', 'view'), async (req, res) => {
    res.json({ data: toOrder(await findOrder(req.params.id)) });
});

/**
 * Move an order along NEXT_STATUS. Marking paid records whatever is still due
 * (so it needs the payment permission); cancelling puts the stock back.
 */
router.patch('/orders/:id/status', validate(z.object({ status: z.enum(Object.keys(NEXT_STATUS)), note: z.string().max(500).optional() })), async (req, res) => {
    const { status, note } = req.body;
    if (!can(req.admin, 'orders', status === 'paid' ? 'payment' : 'edit')) throw forbid();
    const order = await findOrder(req.params.id);
    if (order.status === status) return res.json({ data: toOrder(order) });
    if (!NEXT_STATUS[order.status].includes(status)) {
        throw new AppError(`A ${order.status.replace(/_/g, ' ')} order cannot be marked ${status.replace(/_/g, ' ')}.`, 409);
    }

    if (status === 'cancelled') {
        return res.json({ data: toOrder(await cancelOrder(order, { by: req.admin.name, note, from: [order.status] })) });
    }
    if (status === 'paid') {
        const due = order.total - (await paidSoFar(order.id));
        if (due > 0) await recordTransaction({ orderId: order.id, orderRef: order.ref, type: 'payment', method: order.payment, amount: due, status: 'succeeded', reference: '' });
    }
    // The write only matches from the status read, so two people moving it at once can't both land.
    const moved = await prisma.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status, ...(status === 'paid' ? { paymentStatus: 'paid' } : {}) },
    });
    if (!moved.count) throw new AppError('This order changed while you were looking at it. Reload and try again.', 409);
    const updated = await prisma.order.update({ where: { id: order.id }, data: { history: { push: { status, at: new Date(), by: req.admin.name, note: note ?? null } } } });
    await notifyCustomer(updated, status);
    res.json({ data: toOrder(updated) });
});

/** Payment confirmed by staff (mobile money on their phone, cash in the showroom), in full or in part. */
router.post('/orders/:id/payments', requirePermission('orders', 'payment'), validate(z.object({
    method, reference: z.string().max(120).optional(), amount: z.number().int().positive().optional(),
})), async (req, res) => {
    const order = await findOrder(req.params.id);
    res.json({ data: toOrder(await settlePayment(order, req.body, req.admin.name)) });
});

// Staff notes are private to the dashboard and signed with the staff member's name.
router.post('/orders/:id/notes', requirePermission('orders', 'edit'), validate(z.object({ text: z.string().trim().min(1, 'Write the note first.').max(1000) })), async (req, res) => {
    const order = await findOrder(req.params.id);
    const note = { id: `note_${crypto.randomBytes(5).toString('hex')}`, text: req.body.text, by: req.admin.name, at: new Date() };
    res.json({ data: toOrder(await prisma.order.update({ where: { id: order.id }, data: { notes: { push: note } } })) });
});

/**
 * A sale paid on the spot, in the showroom or on WhatsApp: priced and
 * stock-checked exactly like a shop order, then settled at once.
 */
router.post('/orders/sales', requirePermission('orders', 'payment'), validate(z.object({
    input: checkoutSchema.omit({ payment: true }),
    source: z.enum(['showroom', 'whatsapp']),
    method,
    reference: z.string().max(120).optional(),
    customerId: z.string().nullish(),
})), async (req, res) => {
    const { input, source, method: paidBy, reference = '', customerId } = req.body;
    const customer = customerId ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
    if (customerId && !customer) throw new AppError('That customer no longer exists.', 404);
    const order = await placeOrder({ ...input, payment: paidBy }, { customer, source, by: req.admin.name });
    res.status(201).json({ data: toOrder(await settlePayment(order, { method: paidBy, reference }, req.admin.name)) });
});

/* Returns */

const findReturn = async (id) => {
    const ret = await prisma.returnRequest.findUnique({ where: { id } });
    if (!ret) throw new AppError('That request no longer exists.', 404);
    return ret;
};

// Each open request carries what it would refund now, worked out from the payments only the server sees.
router.get('/returns', requirePermission('orders', 'view'), async (req, res) => {
    const list = await prisma.returnRequest.findMany({ orderBy: { createdAt: 'desc' } });
    const orders = new Map((await prisma.order.findMany({ where: { id: { in: list.map((r) => r.orderId) } } })).map((o) => [o.id, o]));
    const withDue = await Promise.all(list.map(async (r) => {
        const order = orders.get(r.orderId);
        const open = !['rejected', 'refunded', 'exchanged'].includes(r.status);
        return { ...toReturn(r), refundDue: open && order ? await refundDue(r, order) : 0 };
    }));
    res.json({ data: withDue });
});

/** Staff open a return at the counter or on the phone. The window doesn't stop staff; the request says who opened it. */
router.post('/returns', requirePermission('orders', 'edit'), validate(returnInput.extend({ orderId: z.string().min(1) })), async (req, res) => {
    const order = await findOrder(req.body.orderId);
    if (!['delivered', 'exchanged'].includes(order.status)) throw new AppError('Returns open once the order is delivered.', 422);
    const ret = await createReturn(order, req.body, { status: 'approved', note: `Opened by ${req.admin.name}` });
    res.status(201).json({ data: toReturn(ret) });
});

// A refund moves money, so it has its own permission.
router.patch('/returns/:id/status', validate(z.object({
    status: z.enum(['approved', 'rejected', 'received', 'refunded', 'exchanged']),
    note: z.string().max(500).optional(),
    amount: z.number().int().min(0).optional(),
})), async (req, res) => {
    if (!can(req.admin, 'orders', req.body.status === 'refunded' ? 'refund' : 'edit')) throw forbid();
    const { ret } = await updateReturnStatus(await findReturn(req.params.id), req.body, req.admin.name);
    res.json({ data: toReturn(ret) });
});

/* Transactions: money in and out. Most come from orders and returns; staff can record one taken in person. */

const transaction = z.object({
    orderId: z.string(), type: z.enum(['payment', 'refund']), method, amount: z.number().int().positive(),
    status: z.enum(['pending', 'succeeded', 'failed']), reference: z.string().max(120), note: z.string().max(500).nullish(),
});

const canSeeMoney = (req, res, next) => (can(req.admin, 'transactions', 'view') || can(req.admin, 'orders', 'view') ? next() : next(forbid()));

router.get('/transactions', canSeeMoney, async (req, res) => {
    res.json({ data: await prisma.transaction.findMany({ orderBy: { createdAt: 'desc' } }) });
});

router.post('/transactions', requirePermission('orders', 'payment'), validate(transaction.partial().required({ orderId: true, type: true, method: true, amount: true })), async (req, res) => {
    const order = await findOrder(req.body.orderId);
    const row = await recordTransaction({ status: 'succeeded', reference: '', ...req.body, orderRef: order.ref });
    res.status(201).json({ data: row });
});

router.patch('/transactions/:id', requirePermission('orders', 'payment'), validate(transaction.omit({ orderId: true }).partial()), async (req, res) => {
    const row = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!row) throw new AppError('That transaction no longer exists.', 404);
    res.json({ data: await prisma.transaction.update({ where: { id: row.id }, data: req.body }) });
});

router.delete('/transactions/:id', requirePermission('orders', 'delete'), async (req, res) => {
    const row = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!row) throw new AppError('That transaction no longer exists.', 404);
    await prisma.transaction.delete({ where: { id: row.id } });
    res.status(204).end();
});

/* The outbox: every email the shop would send, newest first. */

router.get('/outbox', requirePermission('newsletter', 'view'), async (req, res) => {
    res.json({ data: await prisma.outboxEmail.findMany({ orderBy: { createdAt: 'desc' }, take: 400 }) });
});

/** Send again an email that gave up or was held back (for example, before the mailbox was set up). */
router.post('/outbox/:id/retry', requirePermission('newsletter', 'edit'), async (req, res) => {
    const row = await prisma.outboxEmail.findUnique({ where: { id: req.params.id } }).catch(() => null);
    if (!row) throw new AppError('That email no longer exists.', 404);
    if (row.status === 'sent') throw new AppError('That email was already sent.', 409);
    res.json({ data: await retryEmail(row.id) });
});

/* Customers: staff see and tag them, and carry out privacy requests; the shopper owns their own details. */

router.get('/customers', requirePermission('customers', 'view'), async (req, res) => {
    const list = await prisma.customer.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: list.map(publicCustomer) });
});

router.patch('/customers/:id', requirePermission('customers', 'edit'), validate(z.object({
    notes: z.string().max(2000), tags: z.array(z.string().trim().min(1).max(40)).max(20),
}).partial()), async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) throw new AppError('That customer no longer exists.', 404);
    res.json({ data: publicCustomer(await prisma.customer.update({ where: { id: customer.id }, data: req.body })) });
});

/** A privacy request made by phone or in the showroom: the account goes, its orders stay without the name. */
router.delete('/customers/:id', requirePermission('customers', 'delete'), async (req, res) => {
    await eraseCustomer(req.params.id);
    res.status(204).end();
});

export default router;
