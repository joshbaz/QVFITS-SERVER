import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';

const ATTEMPTS = 5;

/** One line in the stock log; no change writes nothing. */
export const recordMovement = async ({ product, colorId, size, from, to, reason, ref = null, by }) => {
    if (from === to) return;
    const color = (await prisma.color.findUnique({ where: { id: colorId } }))?.name ?? colorId;
    await prisma.stockMovement.create({
        data: { productId: product.id, productName: product.name, color, size, from, to, reason, ref, by },
    });
};

/**
 * Change one variant's stock with a compare-and-set: the write only lands if
 * the count is still what was read, so an order and a staff edit at the same
 * moment can't overwrite each other. Retries on a clash.
 * @param {(current: number) => number} next - the new count from the current one
 * @returns {Promise<{ product: object, variant: object, from: number, to: number } | null>}
 */
const changeStock = async (productId, findVariant, next) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const product = await prisma.product.findUnique({ where: { id: productId } });
        const variant = product && findVariant(product.variants);
        if (!variant) return null;

        const to = Math.max(0, Math.round(next(variant.stock)));
        if (to === variant.stock) return { product, variant, from: variant.stock, to };

        // Prisma can't compare-and-set one element of an embedded list, so this is the raw MongoDB update.
        const result = await prisma.$runCommandRaw({
            update: 'Product',
            updates: [{
                q: { _id: productId, variants: { $elemMatch: { id: variant.id, stock: variant.stock } } },
                u: { $set: { 'variants.$[v].stock': to, updatedAt: { $date: new Date().toISOString() } } },
                arrayFilters: [{ 'v.id': variant.id }],
            }],
        });
        if (result.nModified === 1) return { product, variant, from: variant.stock, to };
    }
    throw new AppError('Stock changed while saving. Please try again.', 409);
};

/**
 * Set one variant's stock (staff, from the Stock tab), with the reason logged.
 * @returns the product as stored after the change
 */
export const setVariantStock = async ({ productId, variantId, stock, reason, by }) => {
    const changed = await changeStock(productId, (variants) => variants.find((v) => v.id === variantId), () => stock);
    if (!changed) throw new AppError('That item no longer exists.', 404);
    const { product, variant, from, to } = changed;
    await recordMovement({ product, colorId: variant.colorId, size: variant.size, from, to, reason, by });
    return { product: await prisma.product.findUnique({ where: { id: productId } }), variant, from, to };
};

/**
 * Move stock on one colour and size and record why: an order passes -qty,
 * a cancellation or a received return +qty. The colour may be given by id
 * or name. Never goes below zero. Ready for the orders API.
 */
export const moveStock = async ({ productId, color, size, delta, reason = 'correction', ref, by }) => {
    const colorId = (await prisma.color.findFirst({ where: { OR: [{ id: color }, { name: color }] } }))?.id ?? color;
    const changed = await changeStock(
        productId,
        (variants) => variants.find((v) => v.colorId === colorId && v.size === size),
        (current) => current + delta,
    );
    if (!changed) return null;
    await recordMovement({ product: changed.product, colorId, size, from: changed.from, to: changed.to, reason, ref, by });
    return changed;
};
