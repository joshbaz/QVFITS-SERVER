/**
 * Fill the catalog with the client's sample data (copied from client/src/data
 * into prisma/seed). Only empty collections are filled, so running it again
 * never overwrites edits made in the admin. `--reset` empties the catalog
 * first. It refuses to run against production.
 *
 *   yarn seed            fill what is empty
 *   yarn seed --reset    start the catalog over
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const reset = process.argv.includes('--reset');
if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
}

const prisma = new PrismaClient();
const read = (name) => JSON.parse(readFileSync(new URL(`./seed/${name}.json`, import.meta.url), 'utf8'));

const photo = ({ id, url = null, width, height, widths = [], colorId = null }) => ({ id, url, width, height, widths, colorId });

const product = (p) => ({
    id: p.id,
    slug: p.slug,
    // Seeded pieces are live already, so their addresses are fixed.
    slugLocked: p.status === 'active',
    name: p.name,
    status: p.status,
    categoryId: p.categoryId ?? '',
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? null,
    salePercent: p.salePercent ?? null,
    type: p.type ?? 'piece',
    kitItems: p.kitItems ?? [],
    isNew: Boolean(p.isNew),
    pinnedBestseller: Boolean(p.pinnedBestseller),
    colorIds: p.colorIds ?? [],
    termIds: p.termIds ?? [],
    blurb: p.blurb ?? '',
    details: p.details ?? [],
    fit: p.fit ?? null,
    fitNote: p.fitNote ?? null,
    fabric: p.fabric ?? null,
    care: p.care ?? null,
    variants: (p.variants ?? []).map(({ id, sku, colorId, size, stock }) => ({ id, sku, colorId, size, stock })),
    photos: (p.photos ?? []).map(photo),
    seo: { title: p.seo?.title ?? '', description: p.seo?.description ?? '' },
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt ?? p.createdAt),
});

const term = (t) => ({ inHeader: false, image: null, target: null, description: '', ...t });
const category = (c) => ({ inHeader: false, image: null, description: '', parentId: null, ...c });
const review = ({ id, productId = null, name, text, stars, status, badge = null, createdAt }) =>
    ({ id, productId, name, text, stars, status, badge, createdAt: new Date(createdAt) });

const TABLES = [
    ['shopGroup', 'shop-groups', (g) => g],
    ['category', 'categories', category],
    ['term', 'terms', term],
    ['color', 'colors', (c) => c],
    ['size', 'sizes', (s) => s],
    ['product', 'products', product],
    ['review', 'reviews', review],
];

const DOCUMENTS = [
    ['filters', () => read('filters')],
    ['size-chart', () => ({ rows: read('size-chart') })],
];

try {
    if (reset) {
        for (const [model] of TABLES) await prisma[model].deleteMany();
        await prisma.stockMovement.deleteMany();
        await prisma.catalogDocument.deleteMany();
        console.log('Catalog emptied.');
    }

    for (const [model, file, shape] of TABLES) {
        if (await prisma[model].count()) {
            console.log(`${model}: has data, left alone`);
            continue;
        }
        const rows = read(file).map(shape);
        await prisma[model].createMany({ data: rows });
        console.log(`${model}: ${rows.length} added`);
    }

    for (const [id, data] of DOCUMENTS) {
        if (await prisma.catalogDocument.findUnique({ where: { id } })) {
            console.log(`${id}: has data, left alone`);
            continue;
        }
        await prisma.catalogDocument.create({ data: { id, data: data() } });
        console.log(`${id}: added`);
    }
} finally {
    await prisma.$disconnect();
}
