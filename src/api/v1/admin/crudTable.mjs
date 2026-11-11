import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { newId } from '../../../services/catalog/slugs.mjs';

const byPosition = { orderBy: { position: 'asc' } };

/**
 * List, create, update, remove and reorder for one table with a `position`,
 * mounted on `router` under `path`, guarded by `module`'s permissions. New
 * rows get a readable id from their name and go to the end. `prepare` builds
 * a new or changed row, and `beforeRemove` refuses a delete that would break
 * something. Lists are open to any signed-in admin unless `listModule` is set.
 */
export function crudTable(router, { path, model, module, listModule, schema, required, label, prepare = async (d) => d, beforeRemove, noun }) {
    const edit = requirePermission(module, 'edit');
    const find = async (id) => {
        const row = await prisma[model].findUnique({ where: { id } });
        if (!row) throw new AppError(`That ${noun} no longer exists.`, 404);
        return row;
    };
    const all = () => prisma[model].findMany(byPosition);
    const canList = listModule ? requirePermission(listModule, 'view') : (req, res, next) => next();

    router.get(`/${path}`, canList, async (req, res) => res.json({ data: await all() }));

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
