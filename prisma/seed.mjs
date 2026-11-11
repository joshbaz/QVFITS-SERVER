/**
 * Fill the shop with the client's sample data (copied from client/src/data
 * into prisma/seed): the catalog, settings, delivery, payment methods,
 * discount codes, customers, orders, payments and returns. Only empty
 * collections are filled, so running it again never overwrites edits made in
 * the admin. `--reset` empties them first. It refuses to run against production.
 * Sample customers sign in with the password in customers.json (demo123).
 *
 *   yarn seed            fill what is empty
 *   yarn seed --reset    start the sample data over
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import bcrypt from 'bcryptjs';
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

const digits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-9);
const date = (v) => (v ? new Date(v) : null);
const demoHash = bcrypt.hashSync('demo123', 10);

const customer = (c) => ({
    id: c.id,
    name: c.name,
    email: c.email.toLowerCase(),
    phone: c.phone ?? null,
    phoneDigits: c.phone ? digits(c.phone) : null,
    // The sample password is demo123 for everyone; anything else is hashed as given.
    passwordHash: c.password === 'demo123' ? demoHash : bcrypt.hashSync(c.password ?? 'demo123', 10),
    addresses: c.addresses ?? [],
    wishlist: c.wishlist ?? [],
    bag: [],
    recentlyViewed: [],
    notes: c.notes ?? '',
    tags: c.tags ?? [],
    emailConfirmedAt: date(c.emailConfirmedAt ?? c.createdAt),
    confirmTokenHash: null,
    resetTokenHash: null,
    resetExpiresAt: null,
    createdAt: new Date(c.createdAt),
});

// Explicit nulls throughout: on MongoDB a filter on null doesn't match a missing field.
const order = (o) => ({
    id: o.id,
    ref: o.ref,
    customerId: o.customerId ?? null,
    name: o.name,
    phone: o.phone,
    phoneDigits: digits(o.phone),
    email: o.email ?? null,
    region: o.region,
    address: o.address ?? null,
    note: o.note ?? null,
    lines: o.lines.map((l) => ({ productId: l.productId, name: l.name, size: l.size, color: l.color, colorId: l.colorId ?? null, qty: l.qty, price: l.price, kitId: l.kitId ?? null })),
    subtotal: o.subtotal,
    delivery: o.delivery,
    discount: o.discount ?? 0,
    discountCode: o.discountCode ?? null,
    kitSaving: o.kitSaving ?? 0,
    total: o.total,
    payment: o.payment,
    paymentStatus: o.paymentStatus,
    status: o.status,
    history: (o.history ?? []).map((h) => ({ status: h.status, at: new Date(h.at), by: h.by, note: h.note ?? null })),
    notes: (o.notes ?? []).map((n) => ({ ...n, at: new Date(n.at) })),
    source: o.source ?? 'web',
    // Past cancellations already gave their stock back.
    stockReturned: o.status === 'cancelled',
    createdAt: new Date(o.createdAt),
});

const discount = (d) => ({
    id: d.id, code: d.code.toUpperCase(), description: d.description ?? '', type: d.type, value: d.value, minSpend: d.minSpend ?? 0,
    startsAt: date(d.startsAt), endsAt: date(d.endsAt), usageLimit: d.usageLimit ?? null, perCustomerLimit: d.perCustomerLimit ?? null,
    appliesTo: d.appliesTo ?? { scope: 'all', ids: [] }, onSaleItems: Boolean(d.onSaleItems), active: d.active !== false, createdAt: new Date(d.createdAt),
});

const transaction = (t) => ({ ...t, reference: t.reference ?? '', note: t.note ?? null, createdAt: new Date(t.createdAt) });
const returnRequest = (r) => ({
    ...r, customerId: r.customerId ?? null, note: r.note ?? null, restocked: ['received', 'refunded', 'exchanged'].includes(r.status),
    createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
});

const TABLES = [
    ['shopGroup', 'shop-groups', (g) => g],
    ['category', 'categories', category],
    ['term', 'terms', term],
    ['color', 'colors', (c) => c],
    ['size', 'sizes', (s) => s],
    ['product', 'products', product],
    ['review', 'reviews', review],
    ['shippingZone', 'shipping-zones', (z) => ({ description: '', freeOver: null, collect: false, etaDays: '', ...z })],
    ['paymentMethod', 'payment-methods', (m) => ({ short: '', instructions: '', ...m })],
    ['discount', 'discounts', discount],
    ['customer', 'customers', customer],
    ['order', 'orders', order],
    ['transaction', 'transactions', transaction],
    ['returnRequest', 'returns', returnRequest],
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
        await prisma.shopDocument.deleteMany();
        await prisma.customerSession.deleteMany();
        await prisma.outboxEmail.deleteMany();
        console.log('Sample data emptied.');
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

    if (await prisma.shopDocument.findUnique({ where: { id: 'settings' } })) console.log('settings: has data, left alone');
    else {
        await prisma.shopDocument.create({ data: { id: 'settings', data: read('settings') } });
        console.log('settings: added');
    }
} finally {
    await prisma.$disconnect();
}
