import express from 'express';
import { z } from 'zod';

import prisma from '../../../../utils/db.mjs';
import { AppError } from '../../../../utils/AppError.js';
import { requireAdmin, requirePermission } from '../../../../middleware/adminAuth.mjs';
import validate from '../../../../middleware/validate.mjs';
import { newId, nextSlug } from '../../../../services/catalog/slugs.mjs';
import { readDocument } from '../../../../services/catalog/views.mjs';

/**
 * The building blocks a product is described with, all edited under Catalog:
 * the "Shop by" groups, categories, the items (terms) of the other groups,
 * colours, sizes, and the shop's filter and sort layout. Ported from the
 * client's attributesApi. Links from the menu, home page and offers still
 * live in the client, so deleting something they show is not checked here yet.
 */
const router = express.Router();
router.use(requireAdmin);

const byPosition = { orderBy: { position: 'asc' } };

const inUse = (count, what) => {
    if (count) throw new AppError(`${count} ${count === 1 ? 'product uses' : 'products use'} this ${what}. Move or edit them first.`, 409);
};

// A picture: a /photos id or an uploaded photo (an https address).
const image = z.union([
    z.string().max(200),
    z.object({ id: z.string(), url: z.string().startsWith('https://', 'A photo did not finish uploading.').nullish(), width: z.number().int(), height: z.number().int(), widths: z.array(z.number().int()).optional() }),
]).nullish();

const name = z.string().trim().min(1, 'Enter a name').max(80);

/**
 * List, create, update, remove and reorder for one table, with the module
 * whose permission guards it. `prepare` builds a new or changed row, and
 * `beforeRemove` refuses a delete that would break something.
 */
function table({ path, model, module, schema, required, label, prepare, beforeRemove, noun }) {
    const edit = requirePermission(module, 'edit');
    const find = async (id) => {
        const row = await prisma[model].findUnique({ where: { id } });
        if (!row) throw new AppError(`That ${noun} no longer exists.`, 404);
        return row;
    };
    const all = () => prisma[model].findMany(byPosition);

    // Any admin may read the lists: the product editor needs categories, colours and sizes to describe a piece.
    router.get(`/${path}`, async (req, res) => res.json({ data: await all() }));

    // A new row needs only its name (and what it belongs to); prepare fills the rest.
    router.post(`/${path}`, edit, validate(schema.partial().required(required)), async (req, res) => {
        const rows = await all();
        const data = await prepare(req.body, null, rows);
        const row = await prisma[model].create({ data: { ...data, id: newId(label(req.body), rows), position: rows.length } });
        res.status(201).json({ data: row });
    });

    // Reordering lists every id, first to last; rows not listed keep their place after.
    router.post(`/${path}/reorder`, edit, validate(z.object({ ids: z.array(z.string()).max(500) })), async (req, res) => {
        const rows = await all();
        const listed = req.body.ids.filter((id) => rows.some((r) => r.id === id));
        const order = [...listed, ...rows.map((r) => r.id).filter((id) => !listed.includes(id))];
        await prisma.$transaction(order.map((id, position) => prisma[model].update({ where: { id }, data: { position } })));
        res.status(204).end();
    });

    router.patch(`/${path}/:id`, edit, validate(schema.partial()), async (req, res) => {
        const existing = await find(req.params.id);
        const data = await prepare(req.body, existing, await all());
        res.json({ data: await prisma[model].update({ where: { id: existing.id }, data }) });
    });

    router.delete(`/${path}/:id`, requirePermission(module, 'delete'), async (req, res) => {
        const row = await find(req.params.id);
        await beforeRemove?.(row);
        await prisma[model].delete({ where: { id: row.id } });
        res.status(204).end();
    });
}

/* Groups: Category is the one system group; it can be renamed and moved but not deleted or doubled. */
table({
    path: 'groups',
    model: 'shopGroup',
    module: 'categories',
    noun: 'group',
    required: { name: true },
    label: (d) => d.name,
    schema: z.object({ name, kind: z.enum(['category', 'tags', 'edits']), inMenu: z.boolean(), inFilters: z.boolean(), active: z.boolean() }),
    prepare: async (data, existing, all) => {
        if (!existing && data.kind === 'category') throw new AppError('There is already a Category group. Add a Tags or Edits group instead.', 409);
        if (existing && data.kind && data.kind !== existing.kind) throw new AppError("A group's kind is set when it is made.", 409);
        // A group and a category both sit right after /shop, so their addresses can't clash.
        const slug = nextSlug({ name: data.name, existing, siblings: all, taken: await prisma.category.findMany() });
        return existing ? { ...data, ...slug } : { kind: 'tags', inMenu: true, inFilters: true, active: true, ...data, ...slug };
    },
    beforeRemove: async (g) => {
        if (g.kind === 'category') throw new AppError("Category is the shop's own group. Rename it if you like, but it stays.", 409);
        const n = await prisma.term.count({ where: { groupId: g.id } });
        if (n) throw new AppError(`${g.name} still has ${n} ${n === 1 ? 'item' : 'items'}. Delete or move them first.`, 409);
    },
});

table({
    path: 'categories',
    model: 'category',
    module: 'categories',
    noun: 'category',
    required: { name: true },
    label: (d) => d.name,
    schema: z.object({ name, parentId: z.string().nullish(), image, description: z.string().max(500), active: z.boolean(), inHeader: z.boolean() }),
    prepare: async (data, existing, all) => {
        const slug = nextSlug({ name: data.name, existing, siblings: all, taken: await prisma.shopGroup.findMany() });
        return existing ? { ...data, ...slug } : { parentId: null, active: true, description: '', image: null, inHeader: false, ...data, ...slug };
    },
    beforeRemove: async (c) => inUse(await prisma.product.count({ where: { categoryId: c.id } }), 'category'),
});

/* Terms: items of tags and edits groups. An address is unique within its own group. */
table({
    path: 'terms',
    model: 'term',
    module: 'categories',
    noun: 'item',
    required: { name: true, groupId: true },
    label: (d) => d.name,
    schema: z.object({
        groupId: z.string(), name, image, description: z.string().max(500), active: z.boolean(), inHeader: z.boolean(),
        target: z.record(z.string(), z.unknown()).nullish(),
    }),
    prepare: async (data, existing, all) => {
        const groupId = existing?.groupId ?? data.groupId;
        const group = groupId ? await prisma.shopGroup.findUnique({ where: { id: groupId } }) : null;
        if (!group || group.kind === 'category') throw new AppError('Pick the group this item belongs to.', 422);
        const siblings = all.filter((t) => t.groupId === groupId);
        const slug = nextSlug({ name: data.name, existing, siblings });
        // An item can't move between groups; its address is only unique within one.
        const { groupId: _ignored, ...rest } = data;
        return existing ? { ...rest, ...slug } : { active: true, description: '', image: null, target: null, inHeader: false, ...rest, groupId, ...slug };
    },
    beforeRemove: async (t) => {
        const group = await prisma.shopGroup.findUnique({ where: { id: t.groupId } });
        inUse(await prisma.product.count({ where: { termIds: { has: t.id } } }), group?.name.toLowerCase() ?? 'item');
    },
});

table({
    path: 'colors',
    model: 'color',
    module: 'categories',
    noun: 'colour',
    required: { name: true, hex: true },
    label: (d) => d.name,
    schema: z.object({ name, hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour') }),
    prepare: async (data) => data,
    beforeRemove: async (c) => inUse(await prisma.product.count({ where: { colorIds: { has: c.id } } }), 'colour'),
});

/* Sizes: variants store the label, so a label in use can't change or go. */
const productsWithSize = (label) => prisma.product.count({ where: { variants: { some: { size: label } } } });
table({
    path: 'sizes',
    model: 'size',
    module: 'size-guide',
    noun: 'size',
    required: { label: true },
    label: (d) => d.label,
    schema: z.object({ label: z.string().trim().min(1, 'Enter a size').max(20), group: z.string().max(40) }),
    prepare: async (data, existing) => {
        if (existing && data.label && data.label !== existing.label) {
            const n = await productsWithSize(existing.label);
            if (n) throw new AppError(`${n} ${n === 1 ? 'product uses' : 'products use'} ${existing.label}. Add a new size instead of renaming it.`, 409);
        }
        return existing ? data : { group: 'apparel', ...data };
    },
    beforeRemove: async (s) => inUse(await productsWithSize(s.label), 'size'),
});

/* The shop's filter drawer and sort menu: one document, merged one level deep like the client's. */

router.get('/filters', requirePermission('categories', 'view'), async (req, res) => {
    res.json({ data: await readDocument('filters', { facets: [], sort: { default: 'featured', options: [] } }) });
});

const facet = z.object({ id: z.string(), label: z.string().max(60), visible: z.boolean(), position: z.number().int() });
const filtersPatch = z.object({
    facets: z.array(facet).max(40),
    sort: z.object({
        default: z.string(),
        options: z.array(z.object({ id: z.string(), label: z.string().max(60), visible: z.boolean(), position: z.number().int() })).max(20),
    }).partial(),
}).partial();

router.patch('/filters', requirePermission('categories', 'edit'), validate(filtersPatch), async (req, res) => {
    const current = await readDocument('filters', {});
    const next = { ...current };
    for (const [k, v] of Object.entries(req.body)) next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...current[k], ...v } : v;
    await prisma.catalogDocument.upsert({ where: { id: 'filters' }, create: { id: 'filters', data: next }, update: { data: next } });
    res.json({ data: next });
});

export default router;
