import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
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

/** The regions offered in an area, and the collection points offered in a region (active ones only). */
export const regionsOf = (zone) => (zone?.regions ?? []).filter((r) => r.active !== false);
export const pointsOf = (region) => (region?.points ?? []).filter((p) => p.active !== false);

const unplaced = (field, message) => new AppError(message, 422, { details: { fieldErrors: { [field]: [message] } } });

/**
 * Where an order goes inside its area, from the ids the checkout sends: the
 * region (needed once an area has regions) and, when collecting, the point in
 * that region. `strict` refuses a missing or no-longer-offered choice; without
 * it (a quote, while the shopper is still choosing) the area's own fee stands in.
 * A legacy "collected from the showroom" area is a collection with no point.
 * @returns {{ area: object|null, point: object|null, collect: boolean }}
 */
export const placeIn = (zone, { zoneRegion, fulfilment, collectionPoint } = {}, { strict = false } = {}) => {
    const regions = regionsOf(zone);
    const area = regions.find((r) => r.id === zoneRegion) ?? null;
    if (strict && regions.length && !area) throw unplaced('zoneRegion', 'Choose your region.');
    const point = fulfilment === 'collect' ? pointsOf(area).find((p) => p.id === collectionPoint) ?? null : null;
    if (strict && fulfilment === 'collect' && !point) throw unplaced('collectionPoint', "Choose where you'll collect it.");
    return { area, point, collect: Boolean(point) || Boolean(zone?.collect) };
};

/**
 * The fee for a zone and subtotal: a region's own fee, else the area's,
 * waived at or over the zone's own threshold, else the shop's. A collection
 * point charges its own fee, never waived.
 */
export const feeFor = (zone, subtotal, shopFreeOver, { area = null, point = null } = {}) => {
    if (!zone) return 0;
    if (point) return point.fee ?? 0;
    const fee = area?.fee ?? zone.fee;
    return subtotal >= (zone.freeOver ?? shopFreeOver) ? 0 : fee;
};
