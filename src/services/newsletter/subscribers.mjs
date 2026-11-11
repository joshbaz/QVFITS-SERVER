import crypto from 'crypto';

import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { newRowId, normalEmail } from '../../utils/ids.mjs';
import { hashToken, randomToken } from '../../utils/tokens.mjs';
import { queueEmail } from '../notify/outbox.mjs';
import { readDocument } from '../shop/documents.mjs';

/**
 * The newsletter list with double opt-in, ported from the client's
 * subscribersApi: signing up stores the address as pending with the words
 * agreed to; the emailed link confirms it; the welcome email (with its code)
 * goes once per address, ever. Unsubscribing keeps the record so the address
 * is never mailed again; erasing deletes it, for a privacy request.
 */

// Asking again within a minute doesn't send another confirmation email.
const COOLDOWN_MS = 60 * 1000;

/** A subscriber as the admin sees them: never a token. */
export const toSubscriber = ({ confirmTokenHash: _t, ...s }) => s;

/**
 * Every newsletter email's unsubscribe link: the subscriber's id signed with
 * the server's secret, so it never needs storing and can't be made up for
 * someone else's address.
 */
const sign = (id) => crypto.createHmac('sha256', env.AUTH_SECRET).update(`unsubscribe:${id}`).digest('base64url').slice(0, 32);
export const unsubscribeLink = (id) => `/newsletter/unsubscribe?token=${id}.${sign(id)}`;

const fromUnsubscribeToken = (token) => {
    const [id, mac] = String(token).split('.');
    const expected = id ? sign(id) : '';
    const ok = mac && mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    return ok ? id : null;
};

// The confirmation carries the consent words they agreed to; they only join the list once the link is opened.
const sendConfirm = async (s) => {
    const token = randomToken();
    await prisma.subscriber.update({ where: { id: s.id }, data: { confirmTokenHash: hashToken(token) } });
    const link = `/newsletter/confirm?token=${token}`;
    await queueEmail({
        to: s.email,
        kind: 'newsletter-confirm',
        subject: 'Confirm your QVFITS newsletter',
        body: `Tap to confirm you want news of drops and offers from QVFITS.\n\n${s.consentText}`,
        link,
    });
    return link;
};

/**
 * Sign up from the footer, the home page, checkout or the account. Already
 * subscribed: nothing changes. Pending: the link is sent again, at most once
 * a minute. Unsubscribed before: they can opt back in.
 * @returns {{ status: 'subscribed'|'pending', email: string, devLink?: string }}
 */
export const subscribe = async (email, { source = 'footer', name = null, customerId = null } = {}) => {
    const clean = normalEmail(email);
    const existing = await prisma.subscriber.findUnique({ where: { email: clean } });
    if (existing?.status === 'subscribed') return { status: 'subscribed', email: clean };
    if (existing?.status === 'pending' && Date.now() - existing.consentedAt.getTime() < COOLDOWN_MS) return { status: 'pending', email: clean };

    const { consentText } = await readDocument('newsletter');
    const now = new Date();
    const row = existing
        ? await prisma.subscriber.update({
            where: { id: existing.id },
            data: { status: 'pending', source: existing.status === 'unsubscribed' ? 'resubscribe' : existing.source, consentText, consentedAt: now, unsubscribedAt: null },
        })
        : await prisma.subscriber.create({
            data: {
                id: newRowId('sub'), email: clean, name, customerId, status: 'pending', source, consentText, consentedAt: now,
                confirmedAt: null, unsubscribedAt: null, confirmTokenHash: null, welcomeSentAt: null,
            },
        });
    const link = await sendConfirm(row);
    return { status: 'pending', email: clean, devLink: link };
};

/** The emailed link: pending becomes subscribed, and the welcome goes out once. */
export const confirmSubscription = async (token) => {
    const s = await prisma.subscriber.findFirst({ where: { confirmTokenHash: hashToken(token) } });
    if (!s) throw new AppError("That link isn't valid any more. Sign up again and we'll send a new one.", 404);
    if (s.status === 'unsubscribed') throw new AppError('This address unsubscribed. Sign up again to rejoin.', 410);
    if (s.status === 'subscribed') return s;

    const settings = await readDocument('newsletter');
    const welcome = settings.welcome.enabled && !s.welcomeSentAt;
    const now = new Date();
    const row = await prisma.subscriber.update({
        where: { id: s.id },
        data: { status: 'subscribed', confirmedAt: now, confirmTokenHash: null, welcomeSentAt: welcome ? now : s.welcomeSentAt },
    });
    if (welcome) {
        await queueEmail({
            to: s.email,
            kind: 'newsletter-welcome',
            subject: settings.welcome.subject,
            body: `${settings.welcome.heading}.\n\n${settings.welcome.body}${settings.welcome.code ? `\n\nYour code: ${settings.welcome.code}` : ''}`,
            link: '/shop',
            unsubscribe: unsubscribeLink(s.id),
        });
    }
    return row;
};

/** Every email's unsubscribe link. The record stays, so the address isn't mailed again. */
export const unsubscribeByToken = async (token) => {
    const id = fromUnsubscribeToken(token);
    const s = id ? await prisma.subscriber.findUnique({ where: { id } }) : null;
    if (!s) throw new AppError("That link isn't valid any more.", 404);
    if (s.status !== 'unsubscribed') await prisma.subscriber.update({ where: { id }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } });
    return { email: s.email };
};

/** Unsubscribe by address (the shopper's own, from their account). Never fails, even if it was never on the list. */
export const unsubscribeEmail = async (email) => {
    await prisma.subscriber.updateMany({ where: { email: normalEmail(email), status: { not: 'unsubscribed' } }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } });
};

/** A privacy request: the address and its consent record are deleted. */
export const eraseSubscriberByEmail = (email) => prisma.subscriber.deleteMany({ where: { email: normalEmail(email) } });
