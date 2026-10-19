import { z } from 'zod';

const int = (min = 0) => z.number({ error: 'Enter a whole number' }).int('Enter a whole number').min(min);

/**
 * A photo as stored. Uploads go through ImageKit first, so a photo is an https
 * address, or (older photos) an id in the client's /photos folder with no url.
 */
const photo = z.object({
    id: z.string().min(1).max(200),
    url: z.string()
        .refine((u) => u.startsWith('https://'), 'A photo did not finish uploading. Remove it and add it again.')
        .nullish(),
    width: int(1),
    height: int(1),
    widths: z.array(int(1)).max(10).optional(),
    colorId: z.string().nullish(),
});

const variant = z.object({
    id: z.string().min(1).max(200),
    sku: z.string().max(80),
    colorId: z.string().min(1),
    size: z.string().min(1).max(20),
    stock: int(),
});

/**
 * The fields a product form may send. View fields (category, stock, badge…)
 * are dropped by zod; the id, address and dates belong to the server.
 * No defaults: zod 4 applies defaults inside partial(), which would wipe unsent fields.
 */
export const productFields = z.object({
    name: z.string().trim().min(1, 'Enter a name').max(120),
    status: z.enum(['draft', 'active', 'archived']),
    categoryId: z.string().max(80),
    price: int(),
    compareAtPrice: int().nullish(),
    salePercent: int(1).max(90, 'A sale is at most 90% off').nullish(),
    type: z.enum(['piece', 'kit']),
    kitItems: z.array(z.string()).max(10),
    isNew: z.boolean(),
    pinnedBestseller: z.boolean(),
    colorIds: z.array(z.string()).max(40),
    termIds: z.array(z.string()).max(40),
    blurb: z.string().max(2000),
    details: z.array(z.string().max(300)).max(20),
    fit: z.enum(['small', 'true', 'large', 'relaxed']).nullish(),
    fitNote: z.string().max(300).nullish(),
    fabric: z.string().max(300).nullish(),
    care: z.string().max(500).nullish(),
    variants: z.array(variant).max(400).refine((vs) => new Set(vs.map((v) => v.id)).size === vs.length, 'Two variants share an id.'),
    photos: z.array(photo).max(12, 'Up to 12 photos'),
    seo: z.object({ title: z.string().max(120), description: z.string().max(300) }),
});

export const productCreateSchema = productFields.partial().required({ name: true });

// `updatedAt` is what the form was opened with, so a save can tell whether stock moved since.
export const productPatchSchema = productFields.partial().extend({ updatedAt: z.coerce.date().optional() });

/** What a bulk action may change: publish, archive, labels, sale, category. */
export const bulkPatchSchema = z.object({
    ids: z.array(z.string()).min(1).max(500),
    patch: productFields.pick({ status: true, isNew: true, pinnedBestseller: true, salePercent: true, categoryId: true }).partial()
        .refine((p) => Object.keys(p).length > 0, 'Nothing to change.'),
});

export const idsSchema = z.object({ ids: z.array(z.string()).min(1).max(500) });

export const reassignSchema = z.object({ from: z.string().min(1), to: z.string().min(1, 'Pick the category to move them to.') });

export const stockSchema = z.object({
    stock: int(),
    reason: z.enum(['restock', 'sale', 'damaged', 'correction']),
});
