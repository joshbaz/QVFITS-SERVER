import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { newRowId } from '../../../utils/ids.mjs';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { readDocument, updateDocument } from '../../../services/shop/documents.mjs';
import { toSubscriber } from '../../../services/newsletter/subscribers.mjs';
import { assertReady, deliverCampaign } from '../../../services/newsletter/campaigns.mjs';

/** The newsletter for the admin: the list, its settings, and campaigns. */
const router = express.Router();
router.use(requireAdmin);

const view = requirePermission('newsletter', 'view');
const edit = requirePermission('newsletter', 'edit');
const remove = requirePermission('newsletter', 'delete');

/* Subscribers */

router.get('/subscribers', view, async (req, res) => {
    res.json({ data: (await prisma.subscriber.findMany({ orderBy: { createdAt: 'desc' } })).map(toSubscriber) });
});

const findSubscriber = async (id) => {
    const s = await prisma.subscriber.findUnique({ where: { id } });
    if (!s) throw new AppError('That subscriber no longer exists.', 404);
    return s;
};

// Staff can unsubscribe someone on request; the record stays, marked unsubscribed.
router.post('/subscribers/:id/unsubscribe', edit, async (req, res) => {
    const s = await findSubscriber(req.params.id);
    res.json({ data: toSubscriber(await prisma.subscriber.update({ where: { id: s.id }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } })) });
});

/** A privacy request: the address and its consent record are deleted. */
router.delete('/subscribers/:id', remove, async (req, res) => {
    const s = await findSubscriber(req.params.id);
    await prisma.subscriber.delete({ where: { id: s.id } });
    res.status(204).end();
});

/* Settings: the consent words and the welcome email */

router.get('/settings', view, async (req, res) => {
    res.json({ data: await readDocument('newsletter') });
});

const welcome = z.object({ enabled: z.boolean(), code: z.string().max(30), subject: z.string().max(150), heading: z.string().max(150), body: z.string().max(2000) });
router.patch('/settings', edit, validate(z.object({ consentText: z.string().trim().min(1).max(500), welcome: welcome.partial() }).partial()), async (req, res) => {
    const current = await readDocument('newsletter');
    const next = { ...current.welcome, ...req.body.welcome };
    // A welcome email that is switched on needs words, or new subscribers would get a blank message.
    if (next.enabled && (!next.subject?.trim() || !next.heading?.trim() || !next.body?.trim())) {
        throw new AppError('The welcome email needs a subject, a heading and some words.', 422);
    }
    res.json({ data: await updateDocument('newsletter', req.body) });
});

/* Campaigns */

const findCampaign = async (id, { editable = true } = {}) => {
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new AppError('That campaign no longer exists.', 404);
    if (editable && ['sent', 'sending'].includes(c.status)) throw new AppError("This campaign has been sent, so it can't change.", 409);
    return c;
};

const campaignFields = z.object({
    subject: z.string().trim().min(1, 'Give it a subject line.').max(150),
    previewText: z.string().max(200),
    heading: z.string().max(150),
    body: z.string().max(5000),
    productIds: z.array(z.string()).max(4, 'Pick up to four pieces.'),
    // The button; the client works out its href from the target when it saves.
    cta: z.object({ label: z.string().max(60), target: z.record(z.string(), z.unknown()).optional(), href: z.string().max(500).nullish() }),
});

router.get('/campaigns', view, async (req, res) => {
    res.json({ data: await prisma.campaign.findMany({ orderBy: { updatedAt: 'desc' } }) });
});

// Saving needs only a subject so a draft can be kept half done.
router.post('/campaigns', edit, validate(campaignFields.partial().required({ subject: true })), async (req, res) => {
    const c = await prisma.campaign.create({
        data: {
            id: newRowId('cmp'), previewText: '', heading: '', body: '', productIds: [], cta: { label: 'Shop now', target: {} },
            ...req.body, status: 'draft', sendAt: null, sentAt: null, recipients: 0,
        },
    });
    res.status(201).json({ data: c });
});

router.patch('/campaigns/:id', edit, validate(campaignFields.partial()), async (req, res) => {
    const c = await findCampaign(req.params.id);
    res.json({ data: await prisma.campaign.update({ where: { id: c.id }, data: req.body }) });
});

// The time must be in the future, and the campaign must be complete.
router.post('/campaigns/:id/schedule', edit, validate(z.object({ sendAt: z.coerce.date() })), async (req, res) => {
    const c = await findCampaign(req.params.id);
    assertReady(c);
    if (!(req.body.sendAt > new Date())) throw new AppError('Pick a time in the future.', 422);
    res.json({ data: await prisma.campaign.update({ where: { id: c.id }, data: { status: 'scheduled', sendAt: req.body.sendAt } }) });
});

router.post('/campaigns/:id/unschedule', edit, async (req, res) => {
    const c = await findCampaign(req.params.id);
    res.json({ data: await prisma.campaign.update({ where: { id: c.id }, data: { status: 'draft', sendAt: null } }) });
});

// Send now: same checks as scheduling, then it is locked as sent.
router.post('/campaigns/:id/send', edit, async (req, res) => {
    res.json({ data: await deliverCampaign(await findCampaign(req.params.id)) });
});

// Drafts and scheduled campaigns can go; a sent one stays as the record of what was emailed.
router.delete('/campaigns/:id', remove, async (req, res) => {
    const c = await findCampaign(req.params.id, { editable: false });
    if (['sent', 'sending'].includes(c.status)) throw new AppError('A sent campaign stays on record.', 409);
    await prisma.campaign.delete({ where: { id: c.id } });
    res.status(204).end();
});

export default router;
