import { env } from '../../env.mjs';

/**
 * Who gets a hidden copy of each kind of email, and who it comes from.
 *
 *   Sales (order updates, low stock): a copy to sales@.
 *   Newsletter (confirm, welcome, campaigns): from info@, with a copy to
 *     info@. A campaign goes to every subscriber, so only one of its emails
 *     carries the copy (meta.teamCopy, set on the first), not one per address.
 *   Contact form messages: from info@, and a reply goes to whoever wrote.
 *
 * Everything else (account and staff emails) comes from MAIL_FROM, as before.
 */
const SALES = new Set(['order-update', 'low-stock']);
const NEWSLETTER = new Set(['newsletter-confirm', 'newsletter-welcome', 'campaign']);
const FROM_INFO = new Set([...NEWSLETTER, 'new-message']);

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
        ...(from ? { from, replyTo: meta?.replyTo || address(from) } : {}),
    };
};
