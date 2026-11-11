import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { loadCatalog, views } from '../catalog/views.mjs';
import { queueEmail } from '../notify/outbox.mjs';
import { unsubscribeLink } from './subscribers.mjs';

/**
 * Newsletter emails, ported from the client's campaignsApi: a draft is
 * written in the admin, then sent now or scheduled. Only confirmed
 * subscribers get it, each with their own unsubscribe link, through the
 * email queue. A sent campaign is locked.
 */

/** A campaign can only be scheduled or sent once it has a subject, a heading and a message. */
export const assertReady = (c) => {
    if (!c.subject.trim()) throw new AppError('Give it a subject line.', 422);
    if (!c.heading.trim() || !c.body.trim()) throw new AppError('Write the heading and the message first.', 422);
};

const salePrice = (p) => (p.salePercent ? Math.round(p.price * (1 - p.salePercent / 100)) : p.price);

// A photo at card width, from wherever it lives: ImageKit, Unsplash, or the shop's own /photos.
const cardImage = (photo) => {
    if (!photo) return null;
    if (photo.url?.startsWith('https://ik.imagekit.io/')) return `${photo.url}?tr=w-400,f-auto,q-70`;
    if (photo.url) return `${photo.url}?w=400&auto=format&q=70`;
    return `${env.APP_URL}/photos/${photo.id}-400.webp`;
};

/** The campaign's pieces as email cards: live ones only, in the order picked. */
const productCards = async (ids) => {
    if (!ids.length) return [];
    const live = views(await loadCatalog()).filter((p) => p.status === 'active');
    return ids.map((id) => live.find((p) => p.id === id)).filter(Boolean)
        .map((p) => ({ name: p.name, price: salePrice(p), url: `/product/${p.slug}`, image: cardImage(p.photos[0]) }));
};

/**
 * Send a campaign to every confirmed subscriber. It is claimed first (draft
 * or scheduled to sending), so a scheduled send and a "Send now" at the same
 * moment can't both go out.
 */
export const deliverCampaign = async (campaign) => {
    assertReady(campaign);
    const list = await prisma.subscriber.findMany({ where: { status: 'subscribed' }, select: { id: true, email: true } });
    if (!list.length) throw new AppError('Nobody has confirmed their subscription yet, so there is no one to send to.', 422);

    const claimed = await prisma.campaign.updateMany({ where: { id: campaign.id, status: { in: ['draft', 'scheduled'] } }, data: { status: 'sending' } });
    if (!claimed.count) throw new AppError('This campaign is already being sent.', 409);

    try {
        const meta = { cards: await productCards(campaign.productIds), cta: campaign.cta?.href ? { label: campaign.cta.label, href: campaign.cta.href } : null };
        for (const s of list) {
            await queueEmail({
                to: s.email,
                kind: 'campaign',
                subject: campaign.subject,
                body: `${campaign.heading}\n\n${campaign.body}`,
                ref: campaign.id,
                unsubscribe: unsubscribeLink(s.id),
                meta,
            });
        }
    } catch (error) {
        // Nothing half sent is left looking unsent: it goes back to a draft to look at.
        await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'draft', sendAt: null } });
        throw error;
    }
    return prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'sent', sentAt: new Date(), recipients: list.length } });
};

/** Scheduled campaigns whose time has come. One that can't go (nobody subscribed) goes back to a draft. */
export const sendDueCampaigns = async () => {
    const due = await prisma.campaign.findMany({ where: { status: 'scheduled', sendAt: { lte: new Date() } } });
    for (const c of due) {
        await deliverCampaign(c).catch(async (error) => {
            console.error(`Scheduled campaign "${c.subject}" not sent:`, error.message);
            await prisma.campaign.updateMany({ where: { id: c.id, status: 'scheduled' }, data: { status: 'draft', sendAt: null } });
        });
    }
    return due.length;
};
