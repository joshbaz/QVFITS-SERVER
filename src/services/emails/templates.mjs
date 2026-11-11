import { env } from '../../env.mjs';

/**
 * One layout for every email: the wordmark, the words, at most one button,
 * and a plain-text twin for mail apps that don't show HTML. Inline styles and
 * a table, because email clients ignore most CSS.
 */

const BRAND = '#8e2462';
const INK = '#2b2530';
const MUTED = '#6f6675';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Each paragraph of the stored body becomes its own <p>; single line breaks stay as <br>.
const paragraphs = (body) => String(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${escape(p).replace(/\n/g, '<br>')}</p>`).join('');

/** The button's words for each kind of email. */
const ACTIONS = {
    'account-confirm': 'Confirm my email',
    'password-reset': 'Choose a new password',
    'staff-invite': 'Set my password',
    'newsletter-confirm': 'Yes, sign me up',
    'order-update': 'Track my order',
    'low-stock': 'Open the stock list',
    'newsletter-welcome': 'Start shopping',
    'new-message': 'Open Messages',
};

// Up to four product cards in a campaign, two to a row.
const cards = (list = []) => {
    if (!list.length) return '';
    const cell = (c) => `<td width="50%" valign="top" style="padding:6px">
<a href="${escape(absolute(c.url))}" style="text-decoration:none;color:${INK}">
${c.image ? `<img src="${escape(c.image)}" width="100%" alt="${escape(c.name)}" style="display:block;width:100%;border-radius:10px">` : ''}
<p style="margin:8px 0 2px;font-weight:600">${escape(c.name)}</p>
<p style="margin:0;color:${MUTED}">UGX ${Number(c.price).toLocaleString('en-UG')}</p></a></td>`;
    const rows = [];
    for (let i = 0; i < list.length; i += 2) rows.push(`<tr>${cell(list[i])}${list[i + 1] ? cell(list[i + 1]) : '<td></td>'}</tr>`);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px">${rows.join('')}</table>`;
};

// Links stored as a path (/account/confirm?token=…) are made absolute for the inbox.
const absolute = (link) => (link && link.startsWith('/') ? `${env.APP_URL}${link}` : link);

/**
 * @param {{ kind: string, subject: string, body: string, link?: string|null, unsubscribe?: string|null, meta?: { cards?: object[], cta?: { label: string, href: string } } | null }} email
 * @returns {{ html: string, text: string }}
 */
export const renderEmail = ({ kind, subject, body, link, unsubscribe, meta }) => {
    // A campaign's own button wins over the default one for its kind.
    const href = absolute(meta?.cta?.href || link);
    const action = href && (meta?.cta?.label || ACTIONS[kind] || 'Open');
    const footer = unsubscribe
        ? `You get this because you signed up to the QVFITS newsletter. <a href="${escape(absolute(unsubscribe))}" style="color:${MUTED}">Unsubscribe</a>.`
        : 'QVFITS, THE CUBE, G17 Kisementi, Kampala.';

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f7f2ee;font-family:Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2ee;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;letter-spacing:2px;color:${BRAND};padding-bottom:20px">QVFITS</td></tr>
<tr><td style="font-size:16px">
<h1 style="font-size:20px;margin:0 0 16px;color:${INK}">${escape(subject)}</h1>
${paragraphs(body)}
${cards(meta?.cards)}
${action ? `<p style="margin:24px 0"><a href="${escape(href)}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">${escape(action)}</a></p>
<p style="margin:0;font-size:12px;color:${MUTED}">Or copy this link: ${escape(href)}</p>` : ''}
</td></tr>
<tr><td style="padding-top:28px;font-size:12px;color:${MUTED};border-top:1px solid #eee6e0;margin-top:24px">${footer}</td></tr>
</table></td></tr></table></body></html>`;

    const text = [subject, '', body, ...(href ? ['', `${action}: ${href}`] : []), '', unsubscribe ? `Unsubscribe: ${absolute(unsubscribe)}` : 'QVFITS, THE CUBE, G17 Kisementi, Kampala.'].join('\n');
    return { html, text };
};
