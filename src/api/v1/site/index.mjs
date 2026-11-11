import express from 'express';
import { z } from 'zod';

import prisma from '../../../utils/db.mjs';
import { newRowId } from '../../../utils/ids.mjs';
import validate from '../../../middleware/validate.mjs';
import { queueEmail } from '../../../services/notify/outbox.mjs';
import { readDocument } from '../../../services/shop/documents.mjs';

/**
 * The storefront's other public reads and writes: what is on offer, the Shop
 * menu's picture tile, the contact form and Vee's questions. Each form is
 * rate limited per address.
 */
const router = express.Router();

// Stored with targets only; the client works out each link's address from the live catalogue.
router.get('/offers', async (req, res) => res.json({ data: await readDocument('offers') }));
router.get('/menu-feature', async (req, res) => res.json({ data: await readDocument('menu-feature') }));

/** The contact form lands in the admin's Messages, and the shop is told by email. */
router.post('/contact', validate(z.object({
    name: z.string({ error: 'Tell us your name.' }).trim().min(1, 'Tell us your name.').max(80),
    phone: z.string().trim().max(40).optional(),
    email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email')]).optional(),
    topic: z.string().trim().max(80).optional(),
    message: z.string({ error: 'Write a message first.' }).trim().min(1, 'Write a message first.').max(3000),
    guard: z.object({ hp: z.string().max(200).optional(), startedAt: z.number().optional() }).optional(),
})), async (req, res) => {
    const { guard, ...input } = req.body;
    // A filled honeypot is thanked like anyone else, and nothing is kept.
    if (guard?.hp) return res.status(201).json({ data: { delivered: true } });
    const message = await prisma.contactMessage.create({
        data: { id: newRowId('msg'), name: input.name, phone: input.phone || null, email: input.email || null, topic: input.topic || null, message: input.message, status: 'new' },
    });
    const { email } = await readDocument('settings');
    if (email) {
        await queueEmail({
            to: email,
            kind: 'new-message',
            subject: `New message from ${message.name}${message.topic ? `: ${message.topic}` : ''}`,
            body: `${message.message}\n\n${[message.phone, message.email].filter(Boolean).join(' · ') || 'No contact details left.'}`,
            link: '/admin/messages',
        });
    }
    res.status(201).json({ data: { delivered: true } });
});

const KEEP_QUESTIONS = 200;

/**
 * What a shopper asked Vee, so the shop can see what she couldn't answer.
 * Only the words and whether she answered are kept; the newest 200.
 */
router.post('/vee/questions', validate(z.object({ text: z.string().trim().min(1).max(200), answered: z.boolean() })), async (req, res) => {
    await prisma.veeQuestion.create({ data: { id: newRowId('vq'), text: req.body.text, answered: req.body.answered } });
    const old = await prisma.veeQuestion.findMany({ orderBy: { createdAt: 'desc' }, skip: KEEP_QUESTIONS, select: { id: true } });
    if (old.length) await prisma.veeQuestion.deleteMany({ where: { id: { in: old.map((q) => q.id) } } });
    res.status(204).end();
});

export default router;
