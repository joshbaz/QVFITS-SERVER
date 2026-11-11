import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { AppError } from '../../../utils/AppError.js';
import { newRowId } from '../../../utils/ids.mjs';
import { requireAdmin, requirePermission } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { discountView } from '../../../services/sales/discounts.mjs';

/** Discount codes, with what each has done, worked out from the orders. */
const router = express.Router();
router.use(requireAdmin);

const date = z.coerce.date().nullable();
// No defaults: zod 4 applies defaults inside partial(), which would wipe unsent fields on an update.
const fields = z.object({
    // Stored in capitals for display; matching ignores case anyway.
    code: z.string().transform((s) => s.trim().toUpperCase().replace(/\s+/g, '')).pipe(z.string().min(1, 'Give the code a name.').max(30)),
    description: z.string().max(300),
    type: z.enum(['percent', 'fixed', 'free_shipping']),
    value: z.number().int().min(0),
    minSpend: z.number().int().min(0),
    startsAt: date,
    endsAt: date,
    usageLimit: z.number().int().min(1).nullable(),
    perCustomerLimit: z.number().int().min(1).nullable(),
    appliesTo: z.object({ scope: z.enum(['all', 'categories', 'products']), ids: z.array(z.string()).max(500) }),
    onSaleItems: z.boolean(),
    active: z.boolean(),
});

const check = (d) => {
    if (d.type === 'percent' && (d.value <= 0 || d.value > 100)) throw new AppError('A percentage has to be between 1 and 100.', 422);
    if (d.startsAt && d.endsAt && d.endsAt < d.startsAt) throw new AppError('The end date is before the start date.', 422);
};

const taken = async (code, selfId) => {
    const other = await prisma.discount.findFirst({ where: { code: { equals: code, mode: 'insensitive' }, id: { not: selfId ?? '' } } });
    if (other) throw new AppError('Another discount already uses that code.', 409);
};

const find = async (id) => {
    const d = await prisma.discount.findUnique({ where: { id } });
    if (!d) throw new AppError('That discount code no longer exists.', 404);
    return d;
};

router.get('/', requirePermission('discounts', 'view'), async (req, res) => {
    const list = await prisma.discount.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: await Promise.all(list.map(discountView)) });
});

router.post('/', requirePermission('discounts', 'edit'), validate(fields.partial().required({ code: true })), async (req, res) => {
    const data = {
        description: '', type: 'percent', value: 10, minSpend: 0, startsAt: null, endsAt: null, usageLimit: null,
        perCustomerLimit: null, appliesTo: { scope: 'all', ids: [] }, onSaleItems: false, active: true, ...req.body,
    };
    check(data);
    await taken(data.code);
    const d = await prisma.discount.create({ data: { ...data, id: newRowId('dsc') } });
    res.status(201).json({ data: await discountView(d) });
});

router.patch('/:id', requirePermission('discounts', 'edit'), validate(fields.partial()), async (req, res) => {
    const existing = await find(req.params.id);
    check({ ...existing, ...req.body });
    if (req.body.code) await taken(req.body.code, existing.id);
    const d = await prisma.discount.update({ where: { id: existing.id }, data: req.body });
    res.json({ data: await discountView(d) });
});

router.delete('/:id', requirePermission('discounts', 'delete'), async (req, res) => {
    const d = await find(req.params.id);
    await prisma.discount.delete({ where: { id: d.id } });
    res.status(204).end();
});

export default router;
