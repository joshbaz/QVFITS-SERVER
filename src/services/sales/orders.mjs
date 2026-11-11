import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { newOrderRef, newRowId, phoneDigits } from '../../utils/ids.mjs';
import { listKits, loadCatalog, views } from '../catalog/views.mjs';
import { returnStock, takeStock, unitsLeft } from '../catalog/stock.mjs';
import { notifyCustomer, queueEmail } from '../notify/outbox.mjs';
import { feeFor, readSettings } from '../shop/settings.mjs';
import { applyDiscount } from './discounts.mjs';
import { toAdmins } from '../../utils/sockets.js';

/**
 * Checkout, orders and payments, ported from the client's checkoutApi and
 * ordersApi. Prices are always worked out here, never trusted from the
 * browser, and always in whole UGX.
 */

const HOUR = 3_600_000;

/** The order an admin may move each status to. Delivered orders end there. */
export const NEXT_STATUS = {
    pending: ['paid', 'cancelled'],
    paid: ['packed', 'cancelled'],
    packed: ['out_for_delivery', 'cancelled'],
    out_for_delivery: ['delivered'],
    delivered: [],
    cancelled: [],
    exchanged: [],
    refunded: [],
};

/** An order as the admin reads it. */
export const toOrder = ({ phoneDigits: _p, stockReturned: _s, updatedAt: _u, ...order }) => order;

/** An order as its shopper reads it: staff notes stay in the dashboard. */
export const toShopperOrder = (order) => {
    const { notes: _notes, ...rest } = toOrder(order);
    return rest;
};

const salePrice = (p) => (p.salePercent ? Math.round(p.price * (1 - p.salePercent / 100)) : p.price);

/** A colour's id from its name, using the product's own colours (their names and ids line up). */
const colorIdFor = (p, name) => {
    const i = p.colors.indexOf(name);
    return i >= 0 ? p.colorIds[i] : name;
};

/**
 * Lines added from a kit carry its id. Each complete set of the kit's pieces
 * is charged the kit's price; a broken-up set falls back to the pieces' own prices.
 */
const kitSavingOf = (priced, kits) => {
    let saving = 0;
    for (const kitId of new Set(priced.map((l) => l.kitId).filter(Boolean))) {
        const kit = kits.find((k) => k.id === kitId);
        if (!kit) continue;
        const tagged = priced.filter((l) => l.kitId === kitId);
        const qtyOf = (id) => tagged.filter((l) => l.productId === id).reduce((n, l) => n + l.qty, 0);
        const sets = Math.min(...kit.items.map(qtyOf));
        if (!Number.isFinite(sets) || sets < 1) continue;
        const separate = kit.items.reduce((n, id) => n + (tagged.find((l) => l.productId === id)?.price ?? 0), 0);
        saving += Math.max(0, separate - kit.price) * sets;
    }
    return saving;
};

/**
 * Price a bag: sale prices, kit prices, the code and delivery, worked out in
 * one place so what is shown is what is charged. Pieces no longer sold drop out.
 * @param {{ productId: string, size: string, color: string, qty: number, kitId?: string }[]} lines
 */
export const quote = async (lines, region, code, who) => {
    const [catalog, settings, zone] = await Promise.all([
        loadCatalog(),
        readSettings(),
        prisma.shippingZone.findFirst({ where: { id: region, active: true } }),
    ]);
    if (!zone) throw new AppError('Pick where we should deliver.', 422, { details: { fieldErrors: { region: ['Pick where we should deliver.'] } } });
    const all = views(catalog);
    const live = all.filter((p) => p.status === 'active' && p.type !== 'kit');

    const priced = lines.flatMap((line) => {
        const p = live.find((x) => x.id === line.productId);
        if (!p) return [];
        return [{ ...line, kitId: line.kitId ?? null, name: p.name, price: salePrice(p), colorId: colorIdFor(p, line.color) }];
    });

    const subtotal = priced.reduce((sum, l) => sum + l.price * l.qty, 0);
    const kitSaving = kitSavingOf(priced, listKits(all));
    const applied = await applyDiscount(code, priced, live, who);
    // A code never takes the goods below nothing; delivery is always charged on its own.
    const discount = Math.min(applied.amount, subtotal - kitSaving);
    const delivery = applied.freeShipping ? 0 : feeFor(zone, subtotal - kitSaving - discount, settings.freeShippingOver);

    return {
        lines: priced,
        subtotal,
        kitSaving,
        delivery,
        discount,
        total: subtotal - kitSaving - discount + delivery,
        discountCode: applied.discount?.code,
        discountReason: applied.reason,
        products: live,
        settings,
    };
};

// A low-stock alert to the shop when an order takes a size down to the alert level.
const alertIfLow = async (changed, line, settings, ref) => {
    const low = settings.lowStockAt;
    if (!settings.email || !(changed.from > low && changed.to <= low)) return;
    await queueEmail({
        to: settings.email,
        kind: 'low-stock',
        ref,
        subject: `${line.name} is running low`,
        body: `${line.name}, ${line.color} ${line.size}: ${changed.to === 0 ? 'sold out' : `${changed.to} left`} after order ${ref}. Restock under Products, Stock.`,
    });
};

/** Put every line of an order back on the shelf, once: the stockReturned flag is claimed first. */
export const restockOrder = async (order, by) => {
    const claimed = await prisma.order.updateMany({ where: { id: order.id, stockReturned: false }, data: { stockReturned: true } });
    if (!claimed.count) return;
    for (const l of order.lines) {
        await returnStock({ productId: l.productId, colorId: l.colorId ?? l.color, size: l.size, qty: l.qty, reason: 'cancel', ref: order.ref, by });
    }
};

/**
 * Place an order: priced on the server, then each line's stock taken
 * atomically. If any line can't be filled, everything already taken goes
 * back and the shopper is told exactly what is short. The order starts
 * pending and unpaid; its stock is held until the unpaid hold runs out.
 * @param {object} input - the checkout form
 * @param {{ customer?: object, source?: string, by?: string }} options
 */
export const placeOrder = async (input, { customer = null, source = 'web', by = 'Checkout' } = {}) => {
    if (!input.lines.length) throw new AppError('Your bag is empty.', 422);
    const who = { customerId: customer?.id, phone: input.phone };
    const priced = await quote(input.lines, input.region, input.discountCode, who);
    if (priced.lines.length !== input.lines.length) throw new AppError('A piece in your bag is no longer sold. Remove it to carry on.', 409);

    // The same colour and size added twice (once on its own, once in a kit) is taken as one.
    const wanted = new Map();
    for (const l of priced.lines) {
        const key = `${l.productId}|${l.colorId}|${l.size}`;
        wanted.set(key, { ...l, qty: (wanted.get(key)?.qty ?? 0) + l.qty });
    }

    let ref = newOrderRef();
    while (await prisma.order.findUnique({ where: { ref }, select: { id: true } })) ref = newOrderRef();

    const taken = [];
    const giveBack = () => Promise.all(taken.map((l) => returnStock({ productId: l.productId, colorId: l.colorId, size: l.size, qty: l.qty, reason: 'cancel', ref, by })));
    for (const l of wanted.values()) {
        const changed = await takeStock({ productId: l.productId, colorId: l.colorId, size: l.size, qty: l.qty, ref, by });
        if (!changed) {
            await giveBack();
            const left = await unitsLeft(l.productId, l.colorId, l.size);
            throw new AppError(`${l.name} in ${l.color}, ${l.size} has ${left} left. Lower the quantity to carry on.`, 409, { code: 'OUT_OF_STOCK' });
        }
        taken.push(l);
        await alertIfLow(changed, l, priced.settings, ref);
    }

    const now = new Date();
    try {
        const order = await prisma.order.create({
            data: {
                id: newRowId('ord'),
                ref,
                customerId: customer?.id ?? null,
                name: input.name,
                phone: input.phone,
                phoneDigits: phoneDigits(input.phone),
                email: input.email || customer?.email || null,
                region: input.region,
                address: input.address || null,
                note: input.note || null,
                lines: priced.lines.map(({ productId, name, size, color, colorId, qty, price, kitId }) => ({ productId, name, size, color, colorId, qty, price, kitId })),
                subtotal: priced.subtotal,
                kitSaving: priced.kitSaving,
                delivery: priced.delivery,
                discount: priced.discount,
                discountCode: priced.discountCode ?? null,
                total: priced.total,
                payment: input.payment,
                paymentStatus: 'unpaid',
                status: 'pending',
                history: [{ status: 'pending', at: now, by, note: null }],
                notes: [],
                source,
            },
        });
        // The admin hears about a new order straight away, rather than at the next refresh.
        toAdmins('order:new', { id: order.id, ref: order.ref, name: order.name, total: order.total, source });
        return order;
    } catch (error) {
        await giveBack();
        throw error;
    }
};

/* Payments */

/** What has come in on an order so far, from its succeeded payments. */
export const paidSoFar = async (orderId) => {
    const rows = await prisma.transaction.findMany({ where: { orderId, type: 'payment', status: 'succeeded' }, select: { amount: true } });
    return rows.reduce((n, t) => n + t.amount, 0);
};

export const recordTransaction = (data) => prisma.transaction.create({ data: { id: newRowId('txn'), reference: '', note: null, ...data } });

/**
 * Records money taken against an order. The amount defaults to what is still
 * due and can never be more; a part payment leaves the order "part paid" with
 * its balance showing. A cancelled order takes no money: its stock has gone
 * back on the shelf, so the sale is recorded afresh.
 */
export const settlePayment = async (order, { method, reference = '', amount }, by) => {
    if (order.status === 'cancelled') throw new AppError('This order was cancelled and its pieces went back on the shelf. Record a new sale instead.', 409);
    const due = order.total - (await paidSoFar(order.id));
    if (due <= 0) throw new AppError('This order is already paid in full.', 409);
    const take = amount === undefined ? due : Math.round(amount);
    if (!(take > 0)) throw new AppError('Enter the amount taken.', 422);
    if (take > due) throw new AppError(`That is more than the ${due.toLocaleString('en-UG')} UGX still due.`, 422);
    await recordTransaction({ orderId: order.id, orderRef: order.ref, type: 'payment', method, amount: take, status: 'succeeded', reference });

    const full = take === due;
    const becomesPaid = full && order.status === 'pending';
    const updated = await prisma.order.update({
        where: { id: order.id },
        data: {
            paymentStatus: full ? 'paid' : 'part_paid',
            payment: method,
            status: becomesPaid ? 'paid' : order.status,
            ...(becomesPaid ? { history: { push: { status: 'paid', at: new Date(), by, note: reference || null } } } : {}),
        },
    });
    if (becomesPaid) await notifyCustomer(updated, 'paid');
    return updated;
};

/* Cancelling and the unpaid hold */

/**
 * Cancel an order and put its stock back. The status write only matches
 * while the order is still in `from`, so a cancel racing a payment can't
 * both win. `at` backdates an expiry to when the hold ran out.
 */
export const cancelOrder = async (order, { by, note, from = [order.status], at = new Date(), extra = '' }) => {
    const moved = await prisma.order.updateMany({
        where: { id: order.id, status: { in: from } },
        data: { status: 'cancelled' },
    });
    if (!moved.count) throw new AppError('This order changed while you were looking at it. Reload and try again.', 409);
    const updated = await prisma.order.update({ where: { id: order.id }, data: { history: { push: { status: 'cancelled', at, by, note: note ?? null } } } });
    await restockOrder(updated, by);
    await notifyCustomer(updated, 'cancelled', extra);
    return prisma.order.findUnique({ where: { id: order.id } });
};

/** A shopper calls off an order they haven't paid for. */
export const cancelUnpaid = (order, by) => {
    if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
        throw new AppError("Only an order that hasn't been paid can be cancelled here. Message us about this one.", 409);
    }
    return cancelOrder(order, { by, note: 'Cancelled by the customer.', from: ['pending'] });
};

/** When an unpaid order stops holding its pieces. */
export const holdsUntil = (order, settings) => order.createdAt.getTime() + (settings.unpaidHoldHours ?? 48) * HOUR;

/**
 * Unpaid orders don't hold stock forever: past the hold time set in Settings,
 * a pending order with nothing paid cancels itself and its pieces go back on
 * the shelf. Run on a schedule (jobs/expireUnpaid.mjs) and before order reads.
 */
export const expireUnpaid = async () => {
    const settings = await readSettings();
    const cutoff = new Date(Date.now() - (settings.unpaidHoldHours ?? 48) * HOUR);
    const stale = await prisma.order.findMany({ where: { status: 'pending', paymentStatus: 'unpaid', createdAt: { lt: cutoff } } });
    for (const o of stale) {
        await cancelOrder(o, {
            by: 'The shop',
            note: 'Not paid in time, so the pieces went back on the shelf.',
            from: ['pending'],
            at: new Date(holdsUntil(o, settings)),
            extra: "It wasn't paid in time. You're welcome to order again.",
        }).catch(() => {
            // Paid or cancelled in the meantime: nothing to expire.
        });
    }
    return stale.length;
};

/** A guest's order by reference and the phone it was placed with; a wrong pair looks like an unknown order. */
export const findByRefAndPhone = async (ref, phone) => {
    const order = await prisma.order.findFirst({ where: { ref: { equals: String(ref).trim(), mode: 'insensitive' }, phoneDigits: phoneDigits(phone) } });
    if (!order) throw new AppError('No order matches that reference and phone number.', 404);
    return order;
};
