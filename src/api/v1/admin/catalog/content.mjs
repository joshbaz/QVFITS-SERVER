import crypto from 'crypto';
import express from 'express';
import { z } from 'zod';

import prisma from '../../../../utils/db.mjs';
import { AppError } from '../../../../utils/AppError.js';
import { requireAdmin, requirePermission } from '../../../../middleware/adminAuth.mjs';
import validate from '../../../../middleware/validate.mjs';
import { readDocument } from '../../../../services/catalog/views.mjs';

/** Reviews (written or approved by staff) and the size chart. */
const router = express.Router();
router.use(requireAdmin);

/* Reviews: a shopper's review waits as pending until staff approve it. */

export const newReviewId = () => `rev_${crypto.randomBytes(6).toString('hex')}`;

const review = z.object({
    productId: z.string().nullish(),
    name: z.string().trim().min(1, 'Enter a name').max(80),
    text: z.string().trim().min(1, 'Write a few words first.').max(2000),
    stars: z.number().int().min(1).max(5),
    status: z.enum(['pending', 'approved', 'hidden']),
    badge: z.string().max(40).nullish(),
});

const findReview = async (id) => {
    const row = await prisma.review.findUnique({ where: { id } });
    if (!row) throw new AppError('That review no longer exists.', 404);
    return row;
};

router.get('/reviews', async (req, res) => {
    res.json({ data: await prisma.review.findMany({ orderBy: { createdAt: 'desc' } }) });
});

// Staff add reviews as approved: they are quoting what a customer told them.
router.post('/reviews', requirePermission('products', 'edit'), validate(review.partial().required({ name: true, text: true })), async (req, res) => {
    const data = { stars: 5, status: 'approved', productId: null, badge: null, ...req.body };
    res.status(201).json({ data: await prisma.review.create({ data: { ...data, id: newReviewId() } }) });
});

router.patch('/reviews/:id', requirePermission('products', 'edit'), validate(review.partial()), async (req, res) => {
    const row = await findReview(req.params.id);
    res.json({ data: await prisma.review.update({ where: { id: row.id }, data: req.body }) });
});

router.delete('/reviews/:id', requirePermission('products', 'delete'), async (req, res) => {
    const row = await findReview(req.params.id);
    await prisma.review.delete({ where: { id: row.id } });
    res.status(204).end();
});

/* Size chart: body measurements in cm per size, with UK / US / EU equivalents. */

const measure = z.union([z.string().max(20), z.number(), z.array(z.number()).max(2)]);
const sizeRow = z.object({ size: z.string().min(1).max(20) }).catchall(measure);

router.get('/size-chart', async (req, res) => {
    res.json({ data: (await readDocument('size-chart', { rows: [] })).rows });
});

router.put('/size-chart', requirePermission('size-guide', 'edit'), validate(z.object({ rows: z.array(sizeRow).max(40) })), async (req, res) => {
    const data = { rows: req.body.rows };
    await prisma.catalogDocument.upsert({ where: { id: 'size-chart' }, create: { id: 'size-chart', data }, update: { data } });
    res.json({ data: data.rows });
});

export default router;
