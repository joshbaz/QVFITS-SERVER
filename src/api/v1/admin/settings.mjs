import express from 'express';
import { z } from 'zod';

import { AppError } from '../../../utils/AppError.js';
import { can } from '../../../utils/permissions.mjs';
import { requireAdmin } from '../../../middleware/adminAuth.mjs';
import validate from '../../../middleware/validate.mjs';
import { activeZones, readSettings, updateSettings } from '../../../services/shop/settings.mjs';
import { crudTable } from './crudTable.mjs';

/**
 * The shop's settings, delivery zones and payment methods, edited under
 * Settings. Vee's page may save Vee's own settings with Vee access alone.
 */
const router = express.Router();
router.use(requireAdmin);

const money = z.number().int().min(0);
const settingsPatch = z.object({
    brand: z.string().max(80), wordmark: z.string().max(80), tagline: z.string().max(200), blurb: z.string().max(1000),
    address: z.string().max(200), addressNote: z.string().max(200), mapsUrl: z.string().max(500),
    phone: z.string().max(40), whatsapp: z.string().max(40), email: z.string().max(120),
    instagram: z.string().max(200), instagramHandle: z.string().max(80), tiktok: z.string().max(200), tiktokHandle: z.string().max(80),
    opensAt: z.string().max(200),
    freeShippingOver: money,
    exchangeDays: z.number().int().min(0).max(365),
    lowStockAt: z.number().int().min(0).max(1000),
    bestsellerCount: z.number().int().min(0).max(50),
    unpaidHoldHours: z.number().int().min(1).max(24 * 30),
    shopGrid: z.object({ phone: z.number().int(), tablet: z.number().int(), desktop: z.number().int() }).partial(),
    ratesUpdated: z.string().max(40),
    currencies: z.array(z.object({ code: z.string().max(5), label: z.string().max(60), perUGX: z.number().positive(), decimals: z.number().int().min(0).max(4), display: z.string().optional() })).max(20),
    assistant: z.record(z.string(), z.unknown()),
}).partial();

router.get('/', async (req, res) => {
    const [settings, zones] = await Promise.all([readSettings(), activeZones()]);
    res.json({ data: { ...settings, zones } });
});

router.patch('/', validate(settingsPatch), async (req, res) => {
    // Vee's own page may save Vee's settings; everything else needs Settings. Zones are edited on their own.
    const onlyVee = Object.keys(req.body).every((k) => k === 'assistant');
    if (!can(req.admin, onlyVee ? 'vee' : 'settings', 'edit')) throw new AppError('Your role does not allow this. Ask the owner for access.', 403);
    const [settings, zones] = await Promise.all([updateSettings(req.body), activeZones()]);
    res.json({ data: { ...settings, zones } });
});

crudTable(router, {
    path: 'shipping-zones',
    model: 'shippingZone',
    module: 'settings',
    noun: 'delivery zone',
    required: { name: true, fee: true },
    label: (d) => d.name,
    schema: z.object({
        name: z.string().trim().min(1, 'Name the zone').max(60), description: z.string().max(300), fee: money,
        freeOver: money.nullable(), collect: z.boolean(), etaDays: z.string().max(40), active: z.boolean(),
    }),
});

crudTable(router, {
    path: 'payment-methods',
    model: 'paymentMethod',
    module: 'settings',
    noun: 'payment method',
    required: { label: true },
    label: (d) => d.label,
    schema: z.object({ label: z.string().trim().min(1, 'Name the method').max(60), short: z.string().max(40), instructions: z.string().max(500), active: z.boolean() }),
});

export default router;
