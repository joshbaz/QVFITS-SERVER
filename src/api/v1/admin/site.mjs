import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { readDocument, updateDocument } from '../../../services/shop/documents.mjs';

/** The admin's inboxes (messages, Vee's questions), the offers, menu tile and home page, and the activity log. */
const router = express.Router();
router.use(requireAdmin);

/* Messages */

const findMessage = async (id) => {
    const m = await prisma.contactMessage.findUnique({ where: { id } });
    if (!m) throw new AppError('That message no longer exists.', 404);
    return m;
};

router.get('/messages', requirePermission('messages', 'view'), async (req, res) => {
    res.json({ data: await prisma.contactMessage.findMany({ orderBy: { createdAt: 'desc' } }) });
});

router.patch('/messages/:id', requirePermission('messages', 'edit'), validate(z.object({ status: z.enum(['new', 'read', 'replied', 'archived']) })), async (req, res) => {
    const m = await findMessage(req.params.id);
    res.json({ data: await prisma.contactMessage.update({ where: { id: m.id }, data: { status: req.body.status } }) });
});

router.delete('/messages/:id', requirePermission('messages', 'delete'), async (req, res) => {
    const m = await findMessage(req.params.id);
    await prisma.contactMessage.delete({ where: { id: m.id } });
    res.status(204).end();
});

/* Vee's questions: Vee's module has view and edit only, so clearing one needs edit. */

router.get('/vee/questions', requirePermission('vee', 'view'), async (req, res) => {
    res.json({ data: await prisma.veeQuestion.findMany({ orderBy: { createdAt: 'desc' } }) });
});

router.delete('/vee/questions/:id', requirePermission('vee', 'edit'), async (req, res) => {
    await prisma.veeQuestion.deleteMany({ where: { id: req.params.id } });
    res.status(204).end();
});

/* Offers, the Shop menu's picture tile and the home page: one document each, merged one level deep. */

// Pictures must be uploaded first; an image held in the browser (a data: or blob: address) would bloat the document.
const noInlineImages = (req, res, next) => (/"(data:(image|video)|blob:)/.test(JSON.stringify(req.body))
    ? next(new AppError('A picture or clip did not finish uploading. Remove it and add it again.', 422))
    : next());
const documentPatch = z.record(z.string(), z.unknown());

// The home page's editable parts, each sent whole: the hero slides, Shop by movement and Seen on you.
// Their items are checked as objects only; the client owns their shape (src/data/home.json).
const items = (max) => z.array(z.looseObject({}), { error: 'Each part must be a list.' }).max(max, `Keep it to ${max} or fewer.`);
const homePatch = z.strictObject({
    heroSlides: items(12).optional(),
    movements: z.looseObject({ title: z.string().max(120).optional(), items: items(24) }).optional(),
    feed: z.looseObject({ title: z.string().max(120).optional(), items: items(24) }).optional(),
}, { error: 'Only the hero, Shop by movement and Seen on you can be saved here.' });

const DOCUMENTS = [
    { path: 'offers', id: 'offers', module: 'offers', schema: documentPatch },
    { path: 'menu-feature', id: 'menu-feature', module: 'categories', schema: documentPatch },
    { path: 'home', id: 'home', module: 'offers', schema: homePatch },
];
for (const doc of DOCUMENTS) {
    router.get(`/content/${doc.path}`, requirePermission(doc.module, 'view'), async (req, res) => res.json({ data: await readDocument(doc.id) }));
    router.patch(`/content/${doc.path}`, requirePermission(doc.module, 'edit'), validate(doc.schema), noInlineImages, async (req, res) => {
        res.json({ data: await updateDocument(doc.id, req.body) });
    });
}

/* The activity log: who changed what. Each admin screen records its own line; the API signs it with who is signed in. */

const KEEP_ACTIVITY = 2000;

router.post('/activity', validate(z.object({
    module: z.string().max(40), action: z.string().max(40), entityId: z.string().max(200).nullish(), summary: z.string().trim().min(1).max(500),
})), async (req, res) => {
    await prisma.activityEntry.create({ data: { ...req.body, entityId: req.body.entityId ?? null, actorId: req.admin.id, actorName: req.admin.name } });
    const old = await prisma.activityEntry.findMany({ orderBy: { at: 'desc' }, skip: KEEP_ACTIVITY, select: { id: true } });
    if (old.length) await prisma.activityEntry.deleteMany({ where: { id: { in: old.map((a) => a.id) } } });
    res.status(204).end();
});

router.get('/activity', requirePermission('activity', 'view'), async (req, res) => {
    res.json({ data: await prisma.activityEntry.findMany({ orderBy: { at: 'desc' }, take: 500 }) });
});

export default router;
