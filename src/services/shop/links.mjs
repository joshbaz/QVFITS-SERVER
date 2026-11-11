import { readDocument } from './documents.mjs';

/**
 * Every stored link in a document (offers, the Shop menu tile), with where it
 * sits, ported from the client's linksIn (src/utils/shopTargets.js). A link
 * is anything with a `target`; its place is named from the titles above it.
 */
const linksIn = (value, where = []) => {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((v) => linksIn(v, where));
    const here = value.title ?? value.label ?? value.name ?? value.cta;
    const path = here ? [...where, here] : where;
    const own = value.target && typeof value.target === 'object' ? [{ target: value.target, where: path.join(' > ') }] : [];
    return [...own, ...Object.entries(value).filter(([k]) => k !== 'target').flatMap(([, v]) => linksIn(v, path))];
};

const SOURCES = [
    { name: 'Offers', id: 'offers' },
    { name: 'the Shop menu tile', id: 'menu-feature' },
];

/**
 * Where a category or term is still linked from, or null. The home page's
 * links live in the site's code and simply drop a link to anything deleted.
 * @param {'categories'|'terms'} kind
 */
export const linkedFrom = async (kind, id) => {
    for (const source of SOURCES) {
        const hit = linksIn(await readDocument(source.id)).find((l) => l.target[kind]?.includes(id));
        if (hit) return `${source.name}${hit.where ? ` (${hit.where})` : ''}`;
    }
    return null;
};
