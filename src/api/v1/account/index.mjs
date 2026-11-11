import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { env } from '../../../env.mjs';
import { AppError } from '../../../utils/AppError.js';
import { phoneDigits } from '../../../utils/ids.mjs';
import validate from '../../../middleware/validate.mjs';
import { requireCustomer } from '../../../middleware/customerAuth.mjs';
import { publicCustomer } from '../../../services/customers/session.mjs';
import { eraseCustomer } from '../../../services/customers/privacy.mjs';
import { cancelUnpaid, expireUnpaid, toShopperOrder } from '../../../services/sales/orders.mjs';
import { requestReturnFor, toReturn } from '../../../services/sales/returns.mjs';
import { cartLines, returnInput } from '../checkout/schemas.mjs';
import { clearCustomerRefreshCookie } from '../../../utils/tokens.mjs';
import { subscribe, unsubscribeEmail } from '../../../services/newsletter/subscribers.mjs';

/** The signed-in shopper's own account (realm: customer). Nobody else's is reachable from here. */
const router = express.Router();
router.use(requireCustomer);

const save = async (req, data) => publicCustomer(await prisma.customer.update({ where: { id: req.customer.id }, data }));

const myOrder = async (req, id) => {
    const order = await prisma.order.findFirst({ where: { id, customerId: req.customer.id } });
    if (!order) throw new AppError('We could not find that order.', 404);
    return order;
};

router.get('/', (req, res) => res.json({ data: publicCustomer(req.customer) }));

// A shopper changes only their name and phone here; one account per phone, as at sign-up.
router.patch('/', validate(z.object({ name: z.string().trim().min(1, 'Enter your name').max(80), phone: z.string().trim().max(30).nullable() }).partial()), async (req, res) => {
    const data = { ...req.body };
    if (data.phone !== undefined) {
        const digits = data.phone ? phoneDigits(data.phone) : null;
        if (digits && await prisma.customer.findFirst({ where: { phoneDigits: digits, id: { not: req.customer.id } } })) {
            throw new AppError('Another account already uses that phone number.', 409);
        }
        data.phone = data.phone || null;
        data.phoneDigits = digits;
    }
    res.json({ data: await save(req, data) });
});

const address = z.object({
    id: z.string().min(1).max(60), label: z.string().max(40), region: z.string().max(60), address: z.string().max(300), phone: z.string().max(40),
});
router.put('/addresses', validate(z.object({ addresses: z.array(address).max(10, 'Up to 10 addresses') })), async (req, res) => {
    res.json({ data: await save(req, { addresses: req.body.addresses }) });
});

router.put('/wishlist', validate(z.object({ wishlist: z.array(z.string().max(200)).max(200) })), async (req, res) => {
    res.json({ data: await save(req, { wishlist: [...new Set(req.body.wishlist)] }) });
});

/** The bag and the recently viewed list follow the account, so another device has them too. */
router.put('/bag', validate(z.object({ bag: cartLines })), async (req, res) => {
    res.json({ data: await save(req, { bag: req.body.bag.map((l) => ({ ...l, kitId: l.kitId ?? null })) }) });
});

router.put('/recently-viewed', validate(z.object({ recentlyViewed: z.array(z.string().max(200)).max(30) })), async (req, res) => {
    res.json({ data: await save(req, { recentlyViewed: req.body.recentlyViewed }) });
});

/* Orders and returns */

router.get('/orders', async (req, res) => {
    await expireUnpaid();
    const orders = await prisma.order.findMany({ where: { customerId: req.customer.id }, orderBy: { createdAt: 'desc' } });
    res.json({ data: orders.map(toShopperOrder) });
});

router.get('/orders/:id', async (req, res) => {
    await expireUnpaid();
    res.json({ data: toShopperOrder(await myOrder(req, req.params.id)) });
});

// Only while nothing is paid (cancelUnpaid enforces it); the pieces go back on the shelf.
router.post('/orders/:id/cancel', async (req, res) => {
    const order = await myOrder(req, req.params.id);
    res.json({ data: toShopperOrder(await cancelUnpaid(order, order.name)) });
});

router.get('/returns', async (req, res) => {
    const list = await prisma.returnRequest.findMany({ where: { customerId: req.customer.id }, orderBy: { createdAt: 'desc' } });
    res.json({ data: list.map(toReturn) });
});

router.post('/returns', validate(returnInput.extend({ orderId: z.string().min(1) })), async (req, res) => {
    const order = await myOrder(req, req.body.orderId);
    res.status(201).json({ data: toReturn(await requestReturnFor(order, req.body)) });
});

/* The newsletter, by the account's own email (nobody else's can be switched from here) */

router.get('/newsletter', async (req, res) => {
    const s = await prisma.subscriber.findUnique({ where: { email: req.customer.email } });
    res.json({ data: s?.status ?? null });
});

// On sends the confirmation email (double opt-in); off unsubscribes, keeping the record.
router.put('/newsletter', validate(z.object({ on: z.boolean() })), async (req, res) => {
    if (!req.body.on) {
        await unsubscribeEmail(req.customer.email);
        return res.json({ data: { status: 'unsubscribed' } });
    }
    const { devLink, ...result } = await subscribe(req.customer.email, { source: 'account', name: req.customer.name, customerId: req.customer.id });
    res.json({ data: env.NODE_ENV !== 'production' && devLink ? { ...result, devLink } : result });
});

/* Privacy (Uganda's Data Protection and Privacy Act 2019) */

/** Everything the shop holds about the shopper, as one file they can keep. */
router.get('/export', async (req, res) => {
    const [orders, returns] = await Promise.all([
        prisma.order.findMany({ where: { customerId: req.customer.id }, orderBy: { createdAt: 'desc' } }),
        prisma.returnRequest.findMany({ where: { customerId: req.customer.id } }),
    ]);
    res.json({ data: { exportedAt: new Date().toISOString(), account: publicCustomer(req.customer), orders: orders.map(toShopperOrder), returns: returns.map(toReturn) } });
});

/** Closes the account. Orders stay for the shop's books but no longer name the person; every device is signed out. */
router.delete('/', async (req, res) => {
    // Erasing deletes every session, so all devices are signed out with it.
    await eraseCustomer(req.customer.id);
    clearCustomerRefreshCookie(res);
    res.status(204).end();
});

export default router;
