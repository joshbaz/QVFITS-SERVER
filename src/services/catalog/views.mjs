import prisma from '../../utils/db.mjs';
import { readSettings } from '../shop/settings.mjs';
import { matchesSearch } from './search.mjs';

/**
 * The catalogue as the shop and the admin read it, ported from the client's
 * productsApi and categoriesApi. A boutique catalogue is small, so each
 * request loads it whole and filters in memory, exactly as the shop expects.
 */

const byPosition = { orderBy: { position: 'asc' } };

/** Statuses that mean the money came in; cancelled and refunded orders don't count. */
export const PAID_STATUSES = ['paid', 'packed', 'out_for_delivery', 'delivered', 'exchanged'];
const SALES_DAYS = 90;

/**
 * Units sold per product in paid orders over the last 90 days, and the best
 * sellers: the top N live pieces by units (N from Settings). Pinned pieces
 * count on top of these (toView).
 * @returns {Promise<{ units: Map<string, number>, top: Set<string> }>}
 */
const loadSales = async (products) => {
    const since = new Date(Date.now() - SALES_DAYS * 86_400_000);
    const [orders, settings] = await Promise.all([
        prisma.order.findMany({ where: { status: { in: PAID_STATUSES }, createdAt: { gte: since } }, select: { lines: true } }),
        readSettings(),
    ]);
    const units = new Map();
    for (const o of orders) for (const l of o.lines) units.set(l.productId, (units.get(l.productId) ?? 0) + l.qty);
    const live = new Set(products.filter((p) => p.status === 'active').map((p) => p.id));
    const top = new Set(
        [...units.entries()]
            .filter(([id, n]) => n > 0 && live.has(id))
            .sort((a, b) => b[1] - a[1])
            .slice(0, settings.bestsellerCount ?? 8)
            .map(([id]) => id),
    );
    return { units, top };
};

/** Every table a product view needs, in the admin's order, and the sales that pick best sellers. */
export const loadCatalog = async () => {
    const [categories, colors, sizes, groups, terms, products] = await Promise.all([
        prisma.category.findMany(byPosition),
        prisma.color.findMany(byPosition),
        prisma.size.findMany(byPosition),
        prisma.shopGroup.findMany(byPosition),
        prisma.term.findMany(byPosition),
        prisma.product.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);
    return { categories, colors, sizes, groups, terms, products, sales: await loadSales(products) };
};

/** What toView needs, built once per request. */
export const viewContext = (catalog) => ({
    categories: new Map(catalog.categories.map((c) => [c.id, c])),
    colors: new Map(catalog.colors.map((c) => [c.id, c])),
    sizeOrder: new Map(catalog.sizes.map((s, i) => [s.label, i])),
    // A single product's view (admin writes) has no sales loaded; it shows pinned best sellers only.
    sales: catalog.sales ?? { units: new Map(), top: new Set() },
});

/** A product with names for its ids, stock per size across colours, and its card label. */
export const toView = (r, ctx) => {
    const isBestseller = r.type !== 'kit' && (r.pinnedBestseller || ctx.sales.top.has(r.id));
    const stock = {};
    const order = (v) => ctx.sizeOrder.get(v.size) ?? 99;
    for (const v of [...r.variants].sort((a, b) => order(a) - order(b))) stock[v.size] = (stock[v.size] ?? 0) + v.stock;
    const category = ctx.categories.get(r.categoryId);
    return {
        ...r,
        isBestseller,
        unitsSold: ctx.sales.units.get(r.id) ?? 0,
        badge: isBestseller ? 'Bestseller' : r.isNew ? 'New' : null,
        category: r.type === 'kit' ? 'Kit' : category?.name ?? 'Uncategorised',
        categorySlug: category?.slug ?? '',
        colors: r.colorIds.map((id) => ctx.colors.get(id)?.name).filter(Boolean),
        stock,
    };
};

export const views = (catalog) => {
    const ctx = viewContext(catalog);
    return catalog.products.map((r) => toView(r, ctx));
};

/* Storefront */

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));
const FEATURED = { Bestseller: 0, New: 1 };
const LABEL_MATCH = { New: (p) => p.isNew, Bestseller: (p) => p.isBestseller };
// The price a shopper pays: the sale percent comes off when the piece has one.
const salePrice = (p) => (p.salePercent ? Math.round(p.price * (1 - p.salePercent / 100)) : p.price);

/** Whether a product passes every filter given; a size or "in stock" filter only counts units on the shelf. */
const matches = (p, f) => {
    const q = f.q?.trim();
    return (
        (!f.categoryId || p.categoryId === f.categoryId)
        && (!f.size || (p.stock[f.size] ?? 0) > 0)
        && (!f.color || p.colors.includes(f.color))
        && (!f.term || f.term.split(',').some((t) => p.termIds.includes(t)))
        && (!f.badge || (LABEL_MATCH[f.badge]?.(p) ?? p.badge === f.badge))
        && (!f.sale || Boolean(p.salePercent))
        && (!f.inStock || Object.values(p.stock).some((n) => n > 0))
        && (!f.maxPrice || salePrice(p) <= f.maxPrice)
        && (!q || matchesSearch([p.name, p.category, p.blurb, p.fabric, ...p.colors, ...(p.details ?? [])].join(' '), q))
    );
};

const sorted = (rows, sort = 'featured') => {
    const list = [...rows];
    if (sort === 'price-asc') return list.sort((a, b) => salePrice(a) - salePrice(b));
    if (sort === 'price-desc') return list.sort((a, b) => salePrice(b) - salePrice(a));
    if (sort === 'new') {
        return list.sort((a, b) => iso(b.createdAt).localeCompare(iso(a.createdAt)) || Number(b.badge === 'New') - Number(a.badge === 'New'));
    }
    return list.sort((a, b) => (FEATURED[a.badge ?? ''] ?? 2) - (FEATURED[b.badge ?? ''] ?? 2));
};

// The shop's pieces. Kits are listed on their own, never in the grid.
export const livePieces = (all) => all.filter((p) => p.status === 'active' && p.type !== 'kit');

export const listProducts = (all, filters = {}) => sorted(livePieces(all).filter((p) => matches(p, filters)), filters.sort);

/** Live kits whose every piece is live and has stock in at least one size. */
export const listKits = (all) => {
    const piece = (id) => all.find((p) => p.id === id && p.status === 'active');
    return all
        .filter((k) => k.type === 'kit' && k.status === 'active')
        .filter((k) => k.kitItems.length >= 2 && k.kitItems.every((id) => Object.values(piece(id)?.stock ?? {}).some((n) => n > 0)))
        .map((k, position) => ({
            id: k.id,
            slug: k.slug,
            title: k.name,
            note: k.blurb,
            items: k.kitItems,
            price: k.price,
            separate: k.kitItems.reduce((n, id) => n + (piece(id)?.price ?? 0), 0),
            photo: k.photos[0],
            position,
            live: true,
        }));
};

/* Facets */

const filterLayout = (filters) => {
    const pos = (a, b) => a.position - b.position;
    return { ...filters, facets: [...(filters.facets ?? [])].sort(pos), sort: { ...filters.sort, options: [...(filters.sort?.options ?? [])].sort(pos) } };
};

/**
 * The shop's live groups, categories, terms, colours, sizes and filter layout.
 * Category and term images stay as stored: a /photos id is resolved by the
 * client, which holds those photos' sizes.
 */
export const facets = (catalog, filters) => {
    const groups = catalog.groups.filter((g) => g.active);
    const live = new Set(groups.map((g) => g.id));
    return {
        groups,
        categoryList: catalog.categories.filter((c) => c.active),
        terms: catalog.terms.filter((t) => t.active && live.has(t.groupId)),
        colors: catalog.colors.map((c) => ({ id: c.id, name: c.name, swatch: c.hex })),
        sizes: catalog.sizes.map((s) => s.label),
        filters: filterLayout(filters ?? { facets: [], sort: { default: 'featured', options: [] } }),
    };
};

/** A catalogue document's data (filters, size chart), or the fallback. */
export const readDocument = async (id, fallback) => (await prisma.catalogDocument.findUnique({ where: { id } }))?.data ?? fallback;
