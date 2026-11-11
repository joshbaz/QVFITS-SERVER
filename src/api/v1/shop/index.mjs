import express from 'express';

import prisma from '../../../utils/db.mjs';
import { activeZones, readSettings } from '../../../services/shop/settings.mjs';

/** What the storefront reads about the shop: settings, delivery zones and how to pay. */
const router = express.Router();

/** The settings plus the live delivery zones, so every page that shows a fee has them. */
router.get('/settings', async (req, res) => {
    const [settings, zones] = await Promise.all([readSettings(), activeZones()]);
    res.json({ data: { ...settings, zones } });
});

router.get('/shipping-zones', async (req, res) => {
    res.json({ data: await activeZones() });
});

router.get('/payment-methods', async (req, res) => {
    res.json({ data: await prisma.paymentMethod.findMany({ where: { active: true }, orderBy: { position: 'asc' } }) });
});

export default router;
