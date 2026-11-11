import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';

const API = 'https://api.imagekit.io/v1/files';
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE = 1000;
const auth = () => `Basic ${Buffer.from(`${env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}`;

/** Every production upload (under /qvfits, never /qvfits-dev), page by page. Throws if ImageKit can't be read, so nothing is deleted on a partial list. */
const listUploads = async () => {
    const files = [];
    for (let skip = 0; ; skip += PAGE) {
        const res = await fetch(`${API}?path=/qvfits&type=file&limit=${PAGE}&skip=${skip}`, { headers: { Authorization: auth() }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`ImageKit listing failed (${res.status})`);
        const page = await res.json();
        files.push(...page);
        if (page.length < PAGE) return files;
    }
};

/**
 * Every photo id and address the shop still uses, found by reading the whole
 * of each place a photo can be kept: products (including copies sharing a
 * photo), category and term pictures, the offers and the Shop menu tile.
 */
const usedReferences = async () => {
    const [products, categories, terms, documents] = await Promise.all([
        prisma.product.findMany({ select: { photos: true } }),
        prisma.category.findMany({ select: { image: true } }),
        prisma.term.findMany({ select: { image: true } }),
        prisma.shopDocument.findMany({ select: { data: true } }),
    ]);
    return { text: JSON.stringify([products, categories, terms, documents]), products: products.length };
};

/**
 * Delete uploads nothing refers to any more: a photo taken off a product, a
 * replaced category picture. A file is only removed when no product,
 * picture or document mentions its id or address, and it is over a week old,
 * so a photo uploaded into a form that isn't saved yet is never touched.
 * Production only: development and test databases share the ImageKit
 * account but not its photos, so from there everything would look unused.
 * @returns {Promise<number>} how many were deleted
 */
export const removeUnusedUploads = async () => {
    if (env.NODE_ENV !== 'production') return 0;
    const used = await usedReferences();
    // An empty catalogue more likely means a database problem than a shop with no products: touch nothing.
    if (!used.products) return 0;
    const cutoff = Date.now() - GRACE_MS;
    const unused = (await listUploads()).filter((f) => f.filePath?.startsWith('/qvfits/') && Date.parse(f.createdAt) < cutoff
        && !used.text.includes(f.fileId) && !used.text.includes(f.filePath));

    let deleted = 0;
    for (const f of unused) {
        const res = await fetch(`${API}/${f.fileId}`, { method: 'DELETE', headers: { Authorization: auth() }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 204 || res.status === 404) deleted++;
    }
    return deleted;
};
