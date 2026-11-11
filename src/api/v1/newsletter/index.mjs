import express from 'express';
import { z } from 'zod';

import { env } from '../../../env.mjs';
import validate from '../../../middleware/validate.mjs';
import { optionalCustomer } from '../../../middleware/customerAuth.mjs';
import { readDocument } from '../../../services/shop/documents.mjs';
import { confirmSubscription, subscribe, toSubscriber, unsubscribeByToken } from '../../../services/newsletter/subscribers.mjs';

/**
 * The newsletter's public side: sign up (double opt-in), the emailed confirm
 * link, and every email's unsubscribe link. Signing up is rate limited per address.
 */
const router = express.Router();

/** The consent words shown under every signup form. */
router.get('/consent', async (req, res) => {
    res.json({ data: (await readDocument('newsletter')).consentText });
});

router.post('/subscribe', optionalCustomer, validate(z.object({
    email: z.string({ error: 'Enter a valid email address.' }).trim().toLowerCase().email('Enter a valid email address.'),
    source: z.enum(['footer', 'home', 'checkout', 'account']).default('footer'),
    name: z.string().trim().max(80).optional(),
    // The public forms' bot check: a hidden field people never fill in.
    guard: z.object({ hp: z.string().max(200).optional(), startedAt: z.number().optional() }).optional(),
})), async (req, res) => {
    // A filled honeypot gets the same answer as a real sign-up, and nothing is stored or sent.
    if (req.body.guard?.hp) return res.json({ data: { status: 'pending', email: req.body.email } });
    const { devLink, ...result } = await subscribe(req.body.email, { source: req.body.source, name: req.body.name ?? null, customerId: req.customer?.id ?? null });
    // Outside production the confirm link comes back too, so the flow can be tried without an inbox.
    res.json({ data: env.NODE_ENV !== 'production' && devLink ? { ...result, devLink } : result });
});

router.post('/confirm', validate(z.object({ token: z.string().min(1).max(200) })), async (req, res) => {
    res.json({ data: toSubscriber(await confirmSubscription(req.body.token)) });
});

router.post('/unsubscribe', validate(z.object({ token: z.string().min(1).max(200) })), async (req, res) => {
    res.json({ data: await unsubscribeByToken(req.body.token) });
});

export default router;
