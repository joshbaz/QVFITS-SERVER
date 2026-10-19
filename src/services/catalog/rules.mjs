import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * The catalogue is set up first: a product needs a category to sit in, and a
 * piece needs colours and sizes to be made in.
 */
export const assertSetUp = async () => {
    const [category, color, size] = await Promise.all([
        prisma.category.findFirst({ where: { active: true }, select: { id: true } }),
        prisma.color.findFirst({ select: { id: true } }),
        prisma.size.findFirst({ select: { id: true } }),
    ]);
    const missing = [!category && 'a category', !color && 'a colour', !size && 'a size'].filter(Boolean);
    if (missing.length) throw new AppError(`Add ${missing.join(', ')} first, under Catalog.`, 422);
};

/** What a product needs before shoppers can see it. Drafts can be saved half done. */
export const assertPublishable = async (r) => {
    if (r.status !== 'active') return;
    if (!r.name?.trim() || !(Number(r.price) > 0)) throw new AppError('A published product needs a name and a price.', 422);
    if (!r.photos?.length) throw new AppError('Add at least one photo before publishing.', 422);
    if (r.type === 'kit') {
        const ids = r.kitItems ?? [];
        if (ids.length < 2) throw new AppError('A kit needs at least two pieces.', 422);
        const pieces = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, status: true } });
        if (pieces.length !== new Set(ids).size || pieces.some((p) => p.type === 'kit')) throw new AppError('A kit can only hold single pieces.', 422);
        if (pieces.some((p) => p.status !== 'active')) throw new AppError('Publish every piece in the kit first.', 422);
        return;
    }
    if (!r.categoryId) throw new AppError('Pick a category before publishing.', 422);
    if (!r.variants?.some((v) => v.stock > 0)) throw new AppError('Add stock in at least one size before publishing.', 422);
};

/**
 * The first kit that holds a piece, if any. `liveOnly` for taking a piece off
 * the shop (a live kit couldn't be sent); any kit for deleting it.
 */
export const kitHolding = (id, { liveOnly = false } = {}) =>
    prisma.product.findFirst({
        where: { type: 'kit', kitItems: { has: id }, ...(liveOnly ? { status: 'active' } : {}) },
        select: { name: true },
    });

/** Refuse ids for colours, categories or terms that don't exist, so a typo can't hide a product. */
export const assertReferences = async ({ categoryId, colorIds, termIds, variants }) => {
    const checks = [];
    if (categoryId) checks.push(prisma.category.count({ where: { id: categoryId } }).then((n) => !n && 'category'));
    const colors = [...new Set([...(colorIds ?? []), ...(variants ?? []).map((v) => v.colorId)])];
    if (colors.length) checks.push(prisma.color.count({ where: { id: { in: colors } } }).then((n) => n !== colors.length && 'colour'));
    if (termIds?.length) checks.push(prisma.term.count({ where: { id: { in: termIds } } }).then((n) => n !== new Set(termIds).size && 'tag'));
    const bad = (await Promise.all(checks)).filter(Boolean);
    if (bad.length) throw new AppError(`That ${bad[0]} no longer exists. Reload the page and pick again.`, 422);
};
