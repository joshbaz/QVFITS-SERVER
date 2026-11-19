import prisma from '../../utils/db.mjs';
// The client's seeds, bundled in as the defaults each stored document is laid over.
import settings from '../../data/settings.json';
import newsletter from '../../data/newsletter.json';
import offers from '../../data/offers.json';
import menuFeature from '../../data/menu-feature.json';

// The home page has no defaults here: the client keeps its own copy (src/data/home.json) and lays
// whatever is stored over it, so only the parts the admin has edited are kept.
const DEFAULTS = { settings, newsletter, offers, 'menu-feature': menuFeature, home: {} };

/**
 * One of the shop's single documents: the settings, the newsletter's
 * settings, the offers, the Shop menu's picture tile and the home page. A field the defaults
 * gained since the document was saved reads from the defaults, so a new
 * setting never arrives as undefined.
 * @param {'settings'|'newsletter'|'offers'|'menu-feature'|'home'} id
 */
export const readDocument = async (id) => {
    const stored = (await prisma.shopDocument.findUnique({ where: { id } }))?.data ?? {};
    return { ...DEFAULTS[id], ...stored };
};

/** Merge a patch one level deep, so saving one section never wipes another. */
export const updateDocument = async (id, patch) => {
    const current = await readDocument(id);
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
        next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...current[k], ...v } : v;
    }
    await prisma.shopDocument.upsert({ where: { id }, create: { id, data: next }, update: { data: next } });
    return next;
};
