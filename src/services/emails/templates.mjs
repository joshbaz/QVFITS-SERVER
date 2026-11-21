import { env } from '../../env.mjs';

/**
 * One layout for every email, drawn to match the admin's preview (EmailPreview
 * in the client): the stacked logo, a centred heading and message, a discount
 * code in a dashed box, product cards, one gradient button, and a cream footer
 * with the shop's address and, for the newsletter, the unsubscribe link. Plus
 * a plain-text twin for mail apps that don't show HTML. Inline styles and
 * tables, because email clients ignore most CSS.
 */

// The site's colours (client/src/index.css).
const C = {
    brand: '#96306e', // brand-500: the button's fallback where gradients aren't drawn (Outlook)
    brandDeep: '#5d2766', // brand-600
    brandSoft: '#d69cbd', // brand-300
    brandTint: '#fbf4f8', // brand-50
    cream: '#fbf8f3',
    cream2: '#f5f0e8',
    ink: '#17211f',
    ink2: '#3a4643',
    ink3: '#57615e',
    ink4: '#68736f',
    line: '#e9e2d7',
};
const GRADIENT = `linear-gradient(135deg,#c2185b,${C.brand} 55%,${C.brandDeep})`;
const FONT = "Jost,'Futura','Helvetica Neue',Helvetica,Arial,sans-serif";

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Each paragraph of the stored body becomes its own <p>; single line breaks stay as <br>.
const paragraphs = (body) => String(body ?? '').split(/\n{2,}/).filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${C.ink2}">${escape(p).replace(/\n/g, '<br>')}</p>`).join('');

/** The button's words for each kind of email. */
const ACTIONS = {
    'account-confirm': 'Confirm my email',
    'password-reset': 'Choose a new password',
    'staff-invite': 'Set my password',
    'newsletter-confirm': 'Yes, sign me up',
    'order-update': 'Track my order',
    'low-stock': 'Open the stock list',
    'newsletter-welcome': 'Shop the new drop',
    'new-message': 'Open Messages',
};

// Links stored as a path (/account/confirm?token=…) are made absolute for the inbox.
const absolute = (link) => (link && link.startsWith('/') ? `${env.APP_URL}${link}` : link);

// The welcome email's code, in a dashed box: "YOUR CODE", the code, and what it is worth.
const codeBox = (code) => !code?.code ? '' : `
<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:24px auto 0;width:100%;max-width:320px">
<tr><td align="center" style="border:2px dashed ${C.brandSoft};background:${C.brandTint};border-radius:18px;padding:16px">
<p style="margin:0;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${C.brandDeep}">Your code</p>
<p style="margin:4px 0 0;font-size:26px;font-weight:700;letter-spacing:2px;color:${C.brandDeep}">${escape(code.code)}</p>
${code.offer ? `<p style="margin:4px 0 0;font-size:13px;color:${C.ink3}">${escape(code.offer)}</p>` : ''}
</td></tr></table>`;

// Up to four product cards in a campaign, two to a row.
const cards = (list = []) => {
    if (!list.length) return '';
    const cell = (c) => `<td width="50%" valign="top" style="padding:6px;text-align:left">
<a href="${escape(absolute(c.url))}" style="text-decoration:none;color:${C.ink}">
${c.image ? `<img src="${escape(c.image)}" width="100%" alt="${escape(c.name)}" style="display:block;width:100%;border-radius:10px;background:${C.cream2}">` : ''}
<p style="margin:8px 0 2px;font-size:13px;font-weight:600;color:${C.ink}">${escape(c.name)}</p>
<p style="margin:0;font-size:13px;color:${C.ink3}">UGX ${Number(c.price).toLocaleString('en-UG')}</p></a></td>`;
    const rows = [];
    for (let i = 0; i < list.length; i += 2) rows.push(`<tr>${cell(list[i])}${list[i + 1] ? cell(list[i + 1]) : '<td></td>'}</tr>`);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0">${rows.join('')}</table>`;
};

// A pill with the brand gradient; plain brand colour where gradients aren't drawn.
const button = (href, label) => `
<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 0"><tr>
<td align="center" bgcolor="${C.brand}" style="border-radius:999px;background-color:${C.brand};background-image:${GRADIENT}">
<a href="${escape(href)}" style="display:inline-block;padding:13px 30px;border-radius:999px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escape(label)}</a>
</td></tr></table>`;

/**
 * @param {{ kind: string, subject: string, body: string, link?: string|null, unsubscribe?: string|null,
 *   meta?: { heading?: string, previewText?: string, code?: { code: string, offer?: string }, cards?: object[], cta?: { label: string, href: string } } | null }} email
 * @param {{ address?: string }} [shop] the shop's address, for the footer
 * @returns {{ html: string, text: string }}
 */
export const renderEmail = ({ kind, subject, body, link, unsubscribe, meta }, shop = {}) => {
    // A campaign's own button wins over the default one for its kind.
    const href = absolute(meta?.cta?.href || link);
    const action = href && (meta?.cta?.label || ACTIONS[kind] || 'Open');
    const heading = meta?.heading || subject;
    const address = shop.address ? `QVFITS, ${shop.address}` : 'QVFITS, Kampala';
    const unsubscribeUrl = unsubscribe ? absolute(unsubscribe) : null;
    const logo = `${env.APP_URL}/logo/qvfits-logo-stacked.png`;

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${escape(subject)}</title>
<style>:root{color-scheme:light only;supported-color-schemes:light only}@media (max-width:480px){.qv-body{padding:24px 18px 28px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${C.cream2};font-family:${FONT};color:${C.ink}">
${meta?.previewText ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(meta.previewText)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.cream2}" style="background:${C.cream2};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:560px;background:#ffffff;border:1px solid ${C.line};border-radius:14px;overflow:hidden">
<tr><td class="qv-body" align="center" style="padding:32px 32px 36px;text-align:center">
<img src="${escape(logo)}" width="64" height="64" alt="QVFITS" style="display:block;margin:0 auto;width:64px;height:64px;border:0">
<h1 style="margin:22px 0 14px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.3px;color:${C.ink}">${escape(heading)}</h1>
${paragraphs(body)}
${codeBox(meta?.code)}
${cards(meta?.cards)}
${action ? button(href, action) : ''}
</td></tr>
<tr><td align="center" bgcolor="${C.cream}" style="background:${C.cream};border-top:1px solid ${C.line};padding:16px 24px;text-align:center;font-size:12px;line-height:1.6;color:${C.ink4}">
<p style="margin:0">${escape(address)}</p>
${unsubscribeUrl ? `<p style="margin:4px 0 0">You are getting this because you joined our list. <a href="${escape(unsubscribeUrl)}" style="color:${C.ink4};text-decoration:underline">Unsubscribe</a></p>` : ''}
</td></tr>
</table></td></tr></table></body></html>`;

    const text = [
        heading,
        '',
        body,
        ...(meta?.code?.code ? ['', `Your code: ${meta.code.code}${meta.code.offer ? ` (${meta.code.offer})` : ''}`] : []),
        ...(href ? ['', `${action}: ${href}`] : []),
        '',
        address,
        ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []),
    ].join('\n');
    return { html, text };
};
