import { z } from 'zod';

import { phoneDigits } from '../../../utils/ids.mjs';

export const cartLines = z.array(z.object({
    productId: z.string().min(1).max(200),
    size: z.string().min(1).max(20),
    color: z.string().min(1).max(60),
    qty: z.number().int().min(1, 'At least one').max(20, 'At most 20 of one piece'),
    kitId: z.string().max(200).nullish(),
})).max(50, 'That is a lot for one order. Message us and we will help.');

export const phone = z.string({ error: 'Enter your phone number' }).trim()
    .refine((p) => phoneDigits(p).length === 9, 'Enter a phone number we can call, like 0772 410 218');

export const checkoutSchema = z.object({
    name: z.string({ error: 'Enter your name' }).trim().min(1, 'Enter your name').max(80),
    phone,
    email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email')]).optional(),
    region: z.string({ error: 'Pick where we should deliver.' }).min(1, 'Pick where we should deliver.'),
    address: z.string().trim().max(300).optional(),
    note: z.string().trim().max(500).optional(),
    payment: z.string({ error: 'Pick how you will pay.' }).min(1, 'Pick how you will pay.'),
    lines: cartLines,
    discountCode: z.string().trim().max(30).optional(),
});

export const quoteSchema = z.object({
    lines: cartLines,
    region: z.string().min(1),
    code: z.string().trim().max(30).optional(),
    // Lets a guest's earlier uses of a one-per-shopper code count too.
    phone: z.string().max(40).optional(),
});

export const returnLines = z.array(z.object({
    productId: z.string(),
    size: z.string(),
    color: z.string(),
    qty: z.number().int().min(1),
})).max(50);

export const returnInput = z.object({
    lines: returnLines,
    reason: z.string({ error: 'Tell us why.' }).trim().min(1, 'Tell us why.').max(500),
    resolution: z.enum(['refund', 'exchange']),
});

export const refAndPhone = z.object({ ref: z.string().trim().min(1, 'Enter the order reference').max(20), phone });
