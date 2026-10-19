// The client's rules for ids and web addresses (src/utils/shopTargets.js and
// services/catalog/attributesApi.ts), so a row gets the same address however it is made.

/** First segments the shop keeps for itself: /shop/new, /shop/bestsellers, /shop/sale, /shop/kits. */
export const RESERVED_SLUGS = new Set(['new', 'bestsellers', 'sale', 'kits']);

/** Attributes: "Tops & Tees" becomes "tops-and-tees". */
export const slugify = (name) =>
    String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Products use the client's own slugify, which joins "&" without spaces. */
export const productSlugify = (name) =>
    String(name ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `base`, or `base-2`, `base-3`… until `taken(slug)` is false. */
export const firstFree = (base, taken) => {
    let slug = base;
    for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
    return slug;
};

/** A new row's readable id from its name, unique in its table. */
export const newId = (name, rows) => {
    const ids = new Set(rows.map((r) => r.id));
    return firstFree(slugify(name) || 'item', (id) => ids.has(id));
};

/**
 * The address a saved row should have. It is made from the name and only
 * changes when the name does; a renamed row keeps its old address in
 * previousSlugs so shared links redirect. It is unique among `siblings`
 * (its own table, or a term's own group) and `taken` (another table sharing
 * the same URL segment), and never a reserved shop word.
 * @returns {{ slug?: string, previousSlugs?: string[] }} only what changes
 */
export const nextSlug = ({ name, existing, siblings, taken = [] }) => {
    const renamed = !existing || (name !== undefined && name !== existing.name);
    if (!renamed) return {};
    const base = slugify(name);
    if (!base) return {};
    const holds = (row, s) => row.slug === s || row.previousSlugs?.includes(s);
    const used = (s) =>
        RESERVED_SLUGS.has(s)
        || taken.some((r) => holds(r, s))
        || siblings.some((r) => r.id !== existing?.id && holds(r, s));
    const slug = firstFree(base, used);
    if (!existing) return { slug, previousSlugs: [] };
    if (existing.slug === slug) return {};
    const previousSlugs = [...new Set([...(existing.previousSlugs ?? []), existing.slug])].filter((s) => s !== slug);
    return { slug, previousSlugs };
};
