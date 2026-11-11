import express from 'express';
import { z } from 'zod';

import prisma from '../../../../utils/db.mjs';
import { AppError } from '../../../../utils/AppError.js';
import { requireAdmin, requirePermission } from '../../../../middleware/adminAuth.mjs';
import validate from '../../../../middleware/validate.mjs';
import { nextSlug } from '../../../../services/catalog/slugs.mjs';
import { crudTable } from '../crudTable.mjs';
import { readDocument } from '../../../../services/catalog/views.mjs';
import { linkedFrom } from '../../../../services/shop/links.mjs';

/**
 * The building blocks a product is described with, all edited under Catalog:
 * the "Shop by" groups, categories, the items (terms) of the other groups,
 * colours, sizes, and the shop's filter and sort layout. Ported from the
 * client's attributesApi. A category or term that offers or the Shop menu
 * tile still link to can't be deleted until that link is changed.
 */
const router = express.Router();
router.use(requireAdmin);

const inLinks = async (kind, row) => {
    const where = await linkedFrom(kind, row.id);
    if (where) throw new AppError(`${row.name} is linked from ${where}. Change that link first.`, 409);
};

const inUse = (count, what) => {
    if (count) throw new AppError(`${count} ${count === 1 ? 'product uses' : 'products use'} this ${what}. Move or edit them first.`, 409);
};

// A picture: a /photos id or an uploaded photo (an https address).
const image = z.union([
    z.string().max(200),
    z.object({ id: z.string(), url: z.string().startsWith('https://', 'A photo did not finish uploading.').nullish(), width: z.number().int(), height: z.number().int(), widths: z.array(z.number().int()).optional() }),
]).nullish();

const name = z.string().trim().min(1, 'Enter a name').max(80);

const table = (options) => crudTable(router, options);

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
    beforeRemove: async (c) => {
        inUse(await prisma.product.count({ where: { categoryId: c.id } }), 'category');
        await inLinks('categories', c);
    },
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
        await inLinks('terms', t);
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
