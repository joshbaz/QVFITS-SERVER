import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { newRowId } from '../../utils/ids.mjs';
import { returnStock } from '../catalog/stock.mjs';
import { notifyCustomer } from '../notify/outbox.mjs';
import { readSettings } from '../shop/settings.mjs';
import { recordTransaction } from './orders.mjs';

/**
 * Returns and exchanges, ported from the client's returnsApi. A shopper asks
 * from their order (or staff log it); staff approve, receive the pieces
 * (stock goes back once), then refund or exchange.
 */

const DAY = 86_400_000;
const CLOSED = ['rejected', 'refunded', 'exchanged'];

/** What each status can move to. */
export const NEXT_RETURN_STATUS = {
    requested: ['approved', 'rejected'],
    approved: ['received', 'rejected'],
    received: ['refunded', 'exchanged'],
    rejected: [],
    refunded: [],
    exchanged: [],
};

export const toReturn = ({ restocked: _r, ...ret }) => ret;

/** Whether an order can still be returned, and why not if it cannot. */
export const returnWindow = (order, settings) => {
    if (order.status !== 'delivered') return { open: false, reason: 'Returns open once the order is delivered.' };
    const delivered = [...order.history].reverse().find((h) => h.status === 'delivered')?.at ?? order.createdAt;
    const days = settings.exchangeDays;
    const open = Date.now() - new Date(delivered).getTime() <= days * DAY;
    return { open, reason: open ? '' : `The ${days}-day window for this order has closed. Message us and we will see what we can do.` };
};

/**
 * The lines asked for, checked against the order: each piece must be on it,
 * in no more than was bought, and priced as it was sold (never as sent).
 */
const linesFromOrder = (order, asked) => {
    if (!asked.length) throw new AppError('Pick at least one piece to return.', 422);
    return asked.map((a) => {
        const sold = order.lines.filter((l) => l.productId === a.productId && l.size === a.size && l.color === a.color);
        const bought = sold.reduce((n, l) => n + l.qty, 0);
        if (!sold.length) throw new AppError("One of those pieces isn't on this order.", 422);
        if (a.qty < 1 || a.qty > bought) throw new AppError(`You bought ${bought} of ${sold[0].name} in ${a.size}.`, 422);
        return { productId: a.productId, name: sold[0].name, size: a.size, color: a.color, qty: a.qty, price: sold[0].price };
    });
};

/** One open request per order at a time. */
export const createReturn = async (order, input, extra = {}) => {
    const lines = linesFromOrder(order, input.lines);
    const open = await prisma.returnRequest.findFirst({ where: { orderId: order.id, status: { notIn: CLOSED } } });
    if (open) throw new AppError('There is already an open request for this order.', 409);
    return prisma.returnRequest.create({
        data: {
            id: newRowId('ret'),
            orderId: order.id,
            orderRef: order.ref,
            customerId: order.customerId ?? null,
            name: order.name,
            lines,
            reason: input.reason,
            resolution: input.resolution,
            status: 'requested',
            note: null,
            ...extra,
        },
    });
};

/** A shopper's request, inside the return window. */
export const requestReturnFor = async (order, input) => {
    const window = returnWindow(order, await readSettings());
    if (!window.open) throw new AppError(window.reason, 422);
    return createReturn(order, input);
};

/**
 * What a return should give back: each returned piece's price less its share
 * of the order's discount and kit saving, spread by value, so a code is never
 * refunded twice. Delivery comes back only when the whole order is returned
 * as faulty. Never more than is left of what was paid.
 */
export const refundDue = async (ret, order) => {
    const goods = ret.lines.reduce((n, l) => n + l.price * l.qty, 0);
    const off = (order.discount ?? 0) + (order.kitSaving ?? 0);
    const share = order.subtotal ? Math.round((off * goods) / order.subtotal) : 0;
    const whole = ret.lines.reduce((n, l) => n + l.qty, 0) === order.lines.reduce((n, l) => n + l.qty, 0);
    const delivery = whole && /faulty|damaged/i.test(ret.reason) ? order.delivery : 0;
    const money = await prisma.transaction.findMany({ where: { orderId: order.id, status: 'succeeded' }, select: { type: true, amount: true } });
    const paid = money.reduce((n, t) => n + (t.type === 'refund' ? -t.amount : t.amount), 0);
    return Math.max(0, Math.min(goods - share + delivery, paid));
};

/**
 * Moves a return along its allowed path. Received puts the pieces back on the
 * shelf (once). Refunded records the money out, at the amount due unless
 * staff lower it with a reason.
 */
export const updateReturnStatus = async (ret, { status, note, amount }, by) => {
    if (!NEXT_RETURN_STATUS[ret.status].includes(status)) throw new AppError(`A ${ret.status} request cannot be marked ${status}.`, 409);
    const order = await prisma.order.findUnique({ where: { id: ret.orderId } });

    // The status write only matches from the status read, so two clicks can't both move it.
    const moved = await prisma.returnRequest.updateMany({ where: { id: ret.id, status: ret.status }, data: { status } });
    if (!moved.count) throw new AppError('This request changed while you were looking at it. Reload and try again.', 409);

    let refunded = 0;
    try {
        if (status === 'received') {
            const claimed = await prisma.returnRequest.updateMany({ where: { id: ret.id, restocked: false }, data: { restocked: true } });
            if (claimed.count) {
                for (const l of ret.lines) {
                    const colorId = order?.lines.find((x) => x.productId === l.productId && x.color === l.color)?.colorId ?? l.color;
                    await returnStock({ productId: l.productId, colorId, size: l.size, qty: l.qty, reason: 'return', ref: ret.orderRef, by });
                }
            }
        }
        if (status === 'refunded' && order) {
            const due = await refundDue(ret, order);
            const give = amount === undefined ? due : Math.round(amount);
            if (give > due) throw new AppError(`The most this return can refund is ${due.toLocaleString('en-UG')} UGX.`, 422);
            if (give < due && !note?.trim()) throw new AppError('Say why the refund is less than the full amount.', 422);
            await recordTransaction({ orderId: order.id, orderRef: order.ref, type: 'refund', method: order.payment, amount: give, status: 'succeeded', reference: note ?? '' });
            refunded = give;
            const all = ret.lines.reduce((n, l) => n + l.qty, 0) === order.lines.reduce((n, l) => n + l.qty, 0);
            const updated = await prisma.order.update({
                where: { id: order.id },
                data: { paymentStatus: all ? 'refunded' : 'partially_refunded', status: all ? 'refunded' : order.status },
            });
            await notifyCustomer(updated, 'refunded', `${give.toLocaleString('en-UG')} UGX to your ${order.payment === 'cash' ? 'hand at the showroom' : 'mobile money'}.`);
        }
        if (status === 'exchanged' && order) await prisma.order.update({ where: { id: order.id }, data: { status: 'exchanged' } });
    } catch (error) {
        // A refund that was refused leaves the request where it was.
        await prisma.returnRequest.updateMany({ where: { id: ret.id, status }, data: { status: ret.status } });
        throw error;
    }

    const updated = await prisma.returnRequest.update({ where: { id: ret.id }, data: { note: note ?? ret.note ?? null } });
    return { ret: updated, refunded };
};
