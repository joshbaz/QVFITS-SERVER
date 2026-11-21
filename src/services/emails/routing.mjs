import { env } from '../../env.mjs';

/**
 * Who gets a hidden copy of each kind of email, and who it comes from.
 *
 *   Sales (order updates, low stock, new orders): a copy to sales@. A new
 *     order goes to sales@ itself (salesInbox), and replies reach the customer.
 *   Newsletter (confirm, welcome, campaigns): from info@, with a copy to
 *     info@. A campaign goes to every subscriber, so only one of its emails
 *     carries the copy (meta.teamCopy, set on the first), not one per address.
 *   Contact form messages: from info@, and a reply goes to whoever wrote.
 *   Account emails (confirm, password reset, staff invite): from info@.
 *
 * Everything else (sales) comes from MAIL_FROM.
 */
const SALES = new Set(['order-update', 'low-stock', 'new-order']);
const NEWSLETTER = new Set(['newsletter-confirm', 'newsletter-welcome', 'campaign']);
const ACCOUNT = new Set(['account-confirm', 'password-reset', 'staff-invite']);
const FROM_INFO = new Set([...NEWSLETTER, ...ACCOUNT, 'new-message']);

const on = (value) => (value && value.toLowerCase() !== 'off' ? value : null);
const address = (value) => /<([^>]+)>/.exec(value)?.[1] ?? value;

/** @returns {{ bcc?: string, from?: string, replyTo?: string }} */
export const routeEmail = ({ kind, to, meta }) => {
    const copy = SALES.has(kind) ? on(env.MAIL_SALES_COPY)
        : NEWSLETTER.has(kind) && (kind !== 'campaign' || meta?.teamCopy) ? on(env.MAIL_NEWSLETTER_COPY)
        : null;
    const from = FROM_INFO.has(kind) ? on(env.MAIL_INFO_FROM) : null;
    return {
        // No copy to the address it is already going to (a low-stock alert sent to sales@ itself).
        ...(copy && copy.toLowerCase() !== String(to).toLowerCase() ? { bcc: copy } : {}),
        ...(from ? { from, replyTo: meta?.replyTo || address(from) } : meta?.replyTo ? { replyTo: meta.replyTo } : {}),
    };
};

/** Where the team's own sales emails go (a new order): sales@, else the shop's email in Settings. */
export const salesInbox = (settings) => on(env.MAIL_SALES_COPY) || settings?.email || null;
