import express from 'express';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import validate from '../../../middleware/validate.mjs';
import { optionalCustomer } from '../../../middleware/customerAuth.mjs';
import { cancelUnpaid, expireUnpaid, findByRefAndPhone, placeOrder, quote, toShopperOrder } from '../../../services/sales/orders.mjs';
import { requestReturnFor, toReturn } from '../../../services/sales/returns.mjs';
import { checkoutSchema, quoteSchema, refAndPhone, returnInput } from './schemas.mjs';

/**
 * Checkout, for guests and signed-in shoppers alike (a valid shopper token
 * links the order to the account), and the guest's order tools: track by
 * reference and phone, cancel while unpaid, ask for a return.
 */
export const checkout = express.Router();
export const guestOrders = express.Router();

// Only what the screen needs from a quote; the products and settings used to work it out stay here.
const publicQuote = ({ products: _p, settings: _s, ...q }) => q;

checkout.post('/quote', optionalCustomer, validate(quoteSchema), async (req, res) => {
    const { lines, region, code, phone } = req.body;
    res.json({ data: publicQuote(await quote(lines, region, code, { customerId: req.customer?.id, phone })) });
});

checkout.post('/orders', optionalCustomer, validate(checkoutSchema), async (req, res) => {
    const input = req.body;
    const [method, zone] = await Promise.all([
        prisma.paymentMethod.findFirst({ where: { id: input.payment, active: true } }),
        prisma.shippingZone.findFirst({ where: { id: input.region, active: true } }),
    ]);
    if (!method) throw new AppError('Pick how you will pay.', 422, { details: { fieldErrors: { payment: ['Pick how you will pay.'] } } });
    // A showroom pickup needs no address; delivery does.
    if (zone && !zone.collect && !input.address) {
        throw new AppError('Tell us where to deliver.', 422, { details: { fieldErrors: { address: ['Tell us where to deliver.'] } } });
    }
    const order = await placeOrder(input, { customer: req.customer });
    res.status(201).json({ data: toShopperOrder(order) });
});

// Reference plus phone is the only key a guest has, so a wrong pair gets the same answer as an unknown order.
guestOrders.post('/track', validate(refAndPhone), async (req, res) => {
    await expireUnpaid();
    res.json({ data: toShopperOrder(await findByRefAndPhone(req.body.ref, req.body.phone)) });
});

guestOrders.post('/cancel', validate(refAndPhone), async (req, res) => {
    const order = await findByRefAndPhone(req.body.ref, req.body.phone);
    res.json({ data: toShopperOrder(await cancelUnpaid(order, order.name)) });
});

guestOrders.post('/return', validate(refAndPhone.extend(returnInput.shape)), async (req, res) => {
    const order = await findByRefAndPhone(req.body.ref, req.body.phone);
    res.status(201).json({ data: toReturn(await requestReturnFor(order, req.body)) });
});
