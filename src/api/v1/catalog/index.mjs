import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import validate from '../../../middleware/validate.mjs';
import { facets, listKits, listProducts, livePieces, loadCatalog, readDocument, views } from '../../../services/catalog/views.mjs';
import { newReviewId } from '../admin/catalog/content.mjs';

/**
 * The storefront's catalogue: what anyone may read. Only live pieces show;
 * drafts and archived products are for the admin (and its preview).
 */
const router = express.Router();

// Query strings arrive as text: "true" for a switch, a number for the price cap.
const flag = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const filtersSchema = z.object({
    categoryId: z.string().max(80).optional(),
    size: z.string().max(20).optional(),
    color: z.string().max(60).optional(),
    term: z.string().max(500).optional(),
    badge: z.string().max(40).optional(),
    sale: flag,
    inStock: flag,
    maxPrice: z.coerce.number().int().positive().optional(),
    q: z.string().max(100).optional(),
    sort: z.enum(['featured', 'price-asc', 'price-desc', 'new']).optional(),
});

router.get('/facets', async (req, res) => {
    const [catalog, filters] = await Promise.all([loadCatalog(), readDocument('filters')]);
    res.json({ data: facets(catalog, filters) });
});

router.get('/products', async (req, res) => {
    const parsed = filtersSchema.safeParse(req.query);
    if (!parsed.success) throw new AppError('Those filters are not valid.', 400);
    res.json({ data: listProducts(views(await loadCatalog()), parsed.data) });
});

/** Several live products by id, in the order asked; missing ids are skipped. For the bag and saved pieces. */
router.get('/products/by-ids', async (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 100);
    const live = livePieces(views(await loadCatalog()));
    res.json({ data: ids.map((id) => live.find((p) => p.id === id)).filter(Boolean) });
});

router.get('/products/:slug', async (req, res) => {
    const product = livePieces(views(await loadCatalog())).find((p) => p.slug === req.params.slug);
    if (!product) throw new AppError('We could not find that piece.', 404);
    res.json({ data: product });
});

router.get('/kits', async (req, res) => {
    res.json({ data: listKits(views(await loadCatalog())) });
});

router.get('/reviews', async (req, res) => {
    res.json({ data: await prisma.review.findMany({ where: { status: 'approved' }, orderBy: { createdAt: 'desc' } }) });
});

/** A shopper's review goes in as pending, for staff to approve. */
router.post('/reviews', validate(z.object({
    name: z.string({ error: 'Enter your name' }).trim().min(1, 'Enter your name').max(80),
    text: z.string({ error: 'Write a few words first.' }).trim().min(1, 'Write a few words first.').max(2000),
    stars: z.number().int().min(1).max(5),
    productId: z.string().max(200).nullish(),
})), async (req, res) => {
    const review = await prisma.review.create({
        data: { ...req.body, productId: req.body.productId ?? null, badge: null, status: 'pending', id: newReviewId() },
    });
    res.status(201).json({ data: review });
});

router.get('/size-chart', async (req, res) => {
    res.json({ data: (await readDocument('size-chart', { rows: [] })).rows });
});

export default router;
