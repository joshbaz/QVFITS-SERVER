import prisma from '../../utils/db.mjs';
import { readDocument, updateDocument } from './documents.mjs';
// The client's seed settings, for Vee's defaults.
import defaults from '../../data/settings.json';

/**
 * The shop's settings: details, contact, stock alerts, the exchange window,
 * the unpaid hold, best sellers, currencies and Vee (a shop document).
 * Vee's section is filled in one level deeper: a copy saved before Vee had a
 * tone, colour pairs or the WhatsApp handover gets the starter ones until the
 * team saves its own (an emptied list is kept as emptied).
 */
export const readSettings = async () => {
    const doc = await readDocument('settings');
    return { ...doc, assistant: { ...defaults.assistant, ...doc.assistant } };
};

/** Merge a patch one level deep, so saving one section never wipes another; the answer is read back with Vee's defaults. */
export const updateSettings = async (patch) => {
    await updateDocument('settings', patch);
    return readSettings();
};

/** The active delivery zones in the admin's order. */
export const activeZones = () => prisma.shippingZone.findMany({ where: { active: true }, orderBy: { position: 'asc' } });

/** The fee for a zone and subtotal: waived at or over the zone's own threshold, else the shop's. */
export const feeFor = (zone, subtotal, shopFreeOver) => {
    if (!zone) return 0;
    return subtotal >= (zone.freeOver ?? shopFreeOver) ? 0 : zone.fee;
};
