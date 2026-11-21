import express from 'express';
import { z } from 'zod';

import validate from '../../../middleware/validate.mjs';
import { findByRefAndPhone } from '../../../services/sales/orders.mjs';
import { handleIpn, retryShopperPayment, shopperPaymentStatus } from '../../../services/payments/payments.mjs';
import { refAndPhone } from '../checkout/schemas.mjs';

/**
 * Online payment through Pesapal: Pesapal's IPN, and the shopper's return
 * page (where the payment stands, and paying again). No sign-in: the order's
 * reference with Pesapal's tracking id, or with the order's phone, is the key.
 */
const router = express.Router();

const ref = z.string({ error: 'Enter your order reference.' }).trim().min(1).max(40);
const trackingId = z.string().trim().min(1).max(100);

const ipnFields = z.object({
    OrderTrackingId: z.string().max(100).optional(),
    OrderMerchantReference: z.string().max(100).optional(),
    OrderNotificationType: z.string().max(40).optional(),
});

// Registered with Pesapal as GET; POST is accepted too. Always Pesapal's own reply shape, never our error envelope.
const ipn = async (req, res) => {
    const parsed = ipnFields.safeParse(req.method === 'GET' ? req.query : req.body);
    const reply = await handleIpn(parsed.success ? parsed.data : {});
    res.status(reply.status === 200 ? 200 : 500).json(reply);
};
router.get('/pesapal/ipn', ipn);
router.post('/pesapal/ipn', ipn);

/** Where the payment stands, for the page Pesapal sends the shopper back to. */
router.post('/status', validate(z.object({ ref, trackingId })), async (req, res) => {
    res.json({ data: await shopperPaymentStatus(req.body) });
});

/** Open Pesapal again for what is still due: with the last attempt's tracking id, or the order's phone. */
router.post('/retry', validate(z.union([z.object({ ref, trackingId }), refAndPhone])), async (req, res) => {
    res.json({ data: await retryShopperPayment(req.body, findByRefAndPhone) });
});

export default router;
