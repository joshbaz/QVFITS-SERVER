import express from 'express';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import validate from '../../../middleware/validate.mjs';
import { optionalCustomer } from '../../../middleware/customerAuth.mjs';
import { cancelUnpaid, expireUnpaid, findByRefAndPhone, placeOrder, quote, toShopperOrder } from '../../../services/sales/orders.mjs';
import { requestReturnFor, toReturn } from '../../../services/sales/returns.mjs';
import { paymentForNewOrder } from '../../../services/payments/payments.mjs';
import { checkoutSchema, quoteSchema, refAndPhone, returnInput } from './schemas.mjs';

/**
 * Checkout, for guests and signed-in shoppers alike (a valid shopper token
 * links the order to the account), and the guest's order tools: track by
 * reference and phone, cancel while unpaid, ask for a return.
 */
export const checkout = express.Router();
export const guestOrders = express.Router();

// Only what the screen needs from a quote; the products, settings and zone used to work it out stay here.
const publicQuote = ({ products: _p, settings: _s, zone: _z, place: _pl, ...q }) => q;

// While the shopper is still choosing a region or point, the area's own fee stands in.
checkout.post('/quote', optionalCustomer, validate(quoteSchema), async (req, res) => {
    const { lines, code, phone, ...where } = req.body;
    res.json({ data: publicQuote(await quote(lines, where, code, { customerId: req.customer?.id, phone })) });
});

checkout.post('/orders', optionalCustomer, validate(checkoutSchema), async (req, res) => {
    const input = req.body;
    const method = await prisma.paymentMethod.findFirst({ where: { id: input.payment, active: true } });
    if (!method) throw new AppError('Pick how you will pay.', 422, { details: { fieldErrors: { payment: ['Pick how you will pay.'] } } });
    // The region, collection point and address are checked as the order is priced (placeOrder).
    const order = await placeOrder(input, { customer: req.customer });
    // MTN, Airtel and card go on to Pesapal's page ({ redirectUrl }); if it can't open, { error } and the order still stands.
    // Not `payment`: that is the order's own field, the method chosen.
    const onlinePayment = await paymentForNewOrder(order);
    res.status(201).json({ data: { ...toShopperOrder(order), onlinePayment } });
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
