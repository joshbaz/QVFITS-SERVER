import express from 'express';

import prisma from '../../../../utils/db.mjs';
import { AppError } from '../../../../utils/AppError.js';
import { requireAdmin, requirePermission } from '../../../../middleware/adminAuth.mjs';
import validate from '../../../../middleware/validate.mjs';
import { productSlugify, firstFree } from '../../../../services/catalog/slugs.mjs';
import { toView, viewContext, loadCatalog, views } from '../../../../services/catalog/views.mjs';
import { recordMovement, setVariantStock } from '../../../../services/catalog/stock.mjs';
import { assertPublishable, assertReferences, assertSetUp, kitHolding } from '../../../../services/catalog/rules.mjs';
import { bulkPatchSchema, idsSchema, productCreateSchema, productPatchSchema, reassignSchema, stockSchema } from './productSchemas.mjs';

/**
 * Products for the admin: drafts included, every write checked against the
 * signed-in person's permissions. Ported from the client's productsApi.
 */
const router = express.Router();
router.use(requireAdmin);

const ATTEMPTS = 3;
const view = requirePermission('products', 'view');
const edit = requirePermission('products', 'edit');
const remove = requirePermission('products', 'delete');

/** One product as screens read it (names for ids, stock per size). */
const viewOf = async (product) => {
    const [categories, colors, sizes] = await Promise.all([prisma.category.findMany(), prisma.color.findMany(), prisma.size.findMany({ orderBy: { position: 'asc' } })]);
    return toView(product, viewContext({ categories, colors, sizes }));
};

const find = async (id) => {
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new AppError('That product no longer exists.', 404);
    return product;
};

const uniqueSlug = async (base, selfId) => {
    const taken = new Set((await prisma.product.findMany({ where: { id: { not: selfId ?? '' } }, select: { slug: true } })).map((p) => p.slug));
    return firstFree(base || 'piece', (s) => taken.has(s));
};

// Stored shapes: optional photo and text fields become explicit values.
const cleanPhotos = (photos) => photos?.map(({ id, url, width, height, widths, colorId }) => ({ id, url: url ?? null, width, height, widths: widths ?? [], colorId: colorId ?? null }));

const byName = (req) => req.admin.name;

/* Reads */

router.get('/', view, async (req, res) => {
    res.json({ data: views(await loadCatalog()) });
});

router.get('/stock-movements', view, async (req, res) => {
    res.json({ data: await prisma.stockMovement.findMany({ orderBy: { at: 'desc' }, take: 1000 }) });
});

// A piece by its address whatever its status, so a draft can be looked at on the real product page.
router.get('/preview/:slug', view, async (req, res) => {
    const product = await prisma.product.findUnique({ where: { slug: req.params.slug } });
    if (!product) throw new AppError('We could not find that piece.', 404);
    res.json({ data: await viewOf(product) });
});

router.get('/:id', view, async (req, res) => {
    res.json({ data: await viewOf(await find(req.params.id)) });
});

/* Writes */

router.post('/', edit, validate(productCreateSchema), async (req, res) => {
    const data = req.body;
    const type = data.type ?? 'piece';
    await assertSetUp();
    await assertReferences(data);
    await assertPublishable({ ...data, type });

    // The address always comes from the name; nobody types one. It is the product's id too.
    const slug = await uniqueSlug(productSlugify(data.name));
    const status = data.status ?? 'draft';
    const product = await prisma.product.create({
        data: {
            ...data,
            id: slug,
            slug,
            slugLocked: status === 'active',
            status,
            type,
            categoryId: data.categoryId ?? '',
            // A draft can be saved before it has a price; publishing still needs one.
            price: data.price ?? 0,
            kitItems: type === 'kit' ? data.kitItems ?? [] : [],
            // A new piece is new unless the admin says otherwise.
            isNew: data.isNew ?? type !== 'kit',
            pinnedBestseller: data.pinnedBestseller ?? false,
            colorIds: data.colorIds ?? [],
            termIds: data.termIds ?? [],
            details: data.details ?? [],
            variants: type === 'kit' ? [] : data.variants ?? [],
            photos: cleanPhotos(data.photos) ?? [],
            seo: data.seo ?? { title: '', description: '' },
        },
    });
    // The opening stock of a new piece goes in the stock log as a restock.
    for (const v of product.variants) {
        await recordMovement({ product, colorId: v.colorId, size: v.size, from: 0, to: v.stock, reason: 'restock', by: byName(req) });
    }
    res.status(201).json({ data: await viewOf(product) });
});

router.patch('/:id', edit, validate(productPatchSchema), async (req, res) => {
    const { updatedAt: openedAt, ...patch } = req.body;
    if (patch.photos) patch.photos = cleanPhotos(patch.photos);
    await assertReferences(patch);

    // Written only if nobody saved in between (orders move stock too); otherwise read again and retry.
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const before = await find(req.params.id);
        const clean = { ...patch };

        // The address follows the name while the piece is a draft that was never live; after that it is frozen, so a shared link never breaks.
        const everLive = before.status === 'active' || before.slugLocked || clean.status === 'active';
        if (clean.name && clean.name !== before.name && !everLive) clean.slug = await uniqueSlug(productSlugify(clean.name), before.id);
        if (everLive) clean.slugLocked = true;

        // Stock moved since the form was opened: keep today's counts for sizes the form already had, so a sale isn't undone.
        if (clean.variants && openedAt && openedAt.getTime() !== before.updatedAt.getTime()) {
            const current = new Map(before.variants.map((v) => [v.id, v.stock]));
            clean.variants = clean.variants.map((v) => (current.has(v.id) ? { ...v, stock: current.get(v.id) } : v));
        }

        await assertPublishable({ ...before, ...clean });
        // A piece still in a live kit can't leave the shop, or the kit couldn't be sent.
        if (clean.status && clean.status !== 'active' && before.type !== 'kit') {
            const kit = await kitHolding(before.id, { liveOnly: true });
            if (kit) throw new AppError(`${before.name} is in the kit ${kit.name}. Take it out of the kit, or unpublish the kit first.`, 409);
        }

        const written = await prisma.product.updateMany({ where: { id: before.id, updatedAt: before.updatedAt }, data: clean });
        if (!written.count) continue;

        const product = await find(before.id);
        // Stock typed into the product form is logged as a count correction.
        if (clean.variants) {
            for (const v of product.variants) {
                const was = before.variants.find((x) => x.id === v.id)?.stock ?? 0;
                await recordMovement({ product, colorId: v.colorId, size: v.size, from: was, to: v.stock, reason: 'correction', by: byName(req) });
            }
        }
        return res.json({ data: await viewOf(product) });
    }
    throw new AppError('This product was changed while saving. Please try again.', 409);
});

// A piece that sits in any kit can't be deleted, or the kit couldn't be sent.
router.delete('/:id', remove, async (req, res) => {
    const product = await find(req.params.id);
    const kit = await kitHolding(product.id);
    if (kit) throw new AppError(`${product.name} is in the kit ${kit.name}. Take it out of the kit first.`, 409);
    await prisma.product.delete({ where: { id: product.id } });
    res.status(204).end();
});

/** One change applied to many products: publish, archive, labels, sale, category. */
router.post('/bulk-update', edit, validate(bulkPatchSchema), async (req, res) => {
    const { ids, patch } = req.body;
    const rows = await prisma.product.findMany({ where: { id: { in: ids } } });
    if (patch.categoryId) await assertReferences({ categoryId: patch.categoryId });

    // Publishing several at once runs the same checks as one at a time, and names the first that fails.
    for (const row of rows) {
        try {
            await assertPublishable({ ...row, ...patch });
        } catch (e) {
            throw new AppError(`${row.name}: ${e.message}`, 422);
        }
        if (patch.status && patch.status !== 'active' && row.type !== 'kit') {
            const kit = await kitHolding(row.id, { liveOnly: true });
            if (kit) throw new AppError(`${row.name} is in the kit ${kit.name}. Take it out of the kit, or unpublish the kit first.`, 409);
        }
    }
    const { count } = await prisma.product.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { ...patch, ...(patch.status === 'active' ? { slugLocked: true } : {}) },
    });
    res.json({ data: count });
});

router.post('/bulk-delete', remove, validate(idsSchema), async (req, res) => {
    const rows = await prisma.product.findMany({ where: { id: { in: req.body.ids } }, select: { id: true, name: true } });
    const leaving = new Set(rows.map((r) => r.id));
    // A piece is only safe to delete if every kit holding it is going too.
    for (const row of rows) {
        const kits = await prisma.product.findMany({ where: { type: 'kit', kitItems: { has: row.id } }, select: { id: true, name: true } });
        const kept = kits.find((k) => !leaving.has(k.id));
        if (kept) throw new AppError(`${row.name} is in the kit ${kept.name}. Take it out of the kit first.`, 409);
    }
    const { count } = await prisma.product.deleteMany({ where: { id: { in: [...leaving] } } });
    res.json({ data: count });
});

/** A copy as a draft with stock at zero, for a new colourway or a similar piece. */
router.post('/:id/duplicate', edit, async (req, res) => {
    const { id, slug: srcSlug, createdAt, updatedAt, ...src } = await find(req.params.id);
    const slug = await uniqueSlug(`${srcSlug}-copy`);
    const copy = await prisma.product.create({
        data: {
            ...src,
            id: slug,
            slug,
            slugLocked: false,
            name: `${src.name} (copy)`,
            status: 'draft',
            pinnedBestseller: false,
            variants: src.variants.map((v) => ({ ...v, id: v.id.replace(id, slug), stock: 0 })),
        },
    });
    res.status(201).json({ data: await viewOf(copy) });
});

/** Moves every product in one category to another, so the first can be deleted. */
router.post('/reassign-category', edit, validate(reassignSchema), async (req, res) => {
    const { from, to } = req.body;
    if (from === to) throw new AppError('Pick a different category to move them to.', 422);
    await assertReferences({ categoryId: to });
    const { count } = await prisma.product.updateMany({ where: { categoryId: from }, data: { categoryId: to } });
    res.json({ data: count });
});

/** One size's stock, with the reason in the stock log. */
router.put('/:id/variants/:variantId/stock', edit, validate(stockSchema), async (req, res) => {
    const { product } = await setVariantStock({
        productId: req.params.id,
        variantId: req.params.variantId,
        stock: req.body.stock,
        reason: req.body.reason,
        by: byName(req),
    });
    res.json({ data: await viewOf(product) });
});

export default router;
