import nodemailer from 'nodemailer';
import { env } from '../../env.mjs';

/**
 * Sending email: through ZeptoMail's API when its token is set (HTTPS, so a
 * DigitalOcean Droplet can use it: Droplets block the SMTP ports), else
 * through Zoho Mail's SMTP server. Ported from artistry360. Only the email
 * queue calls this (services/emails/queue.mjs), so a slow or failing send
 * never holds up a shopper's request, and a failure is retried.
 */

/** Whether ZeptoMail or a Zoho mailbox is set up. */
export const isMailConfigured = () => Boolean(env.ZEPTOMAIL_TOKEN || (env.ZOHO_SMTP_USER && env.ZOHO_SMTP_PASSWORD));

/** Which way email goes, for the test script and the logs. */
export const mailRoute = () => (env.ZEPTOMAIL_TOKEN ? 'zeptomail' : env.ZOHO_SMTP_USER && env.ZOHO_SMTP_PASSWORD ? 'smtp' : 'none');

const from = () => env.MAIL_FROM || `QVFITS <${env.ZOHO_SMTP_USER}>`;

/** "QVFITS <orders@…>" or a bare address → { name, address }. */
const parseAddress = (value) => {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value ?? '');
    return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(value ?? '').trim() };
};

/** The team's own mailbox (where replies land): MAIL_REPLY_TO, else the sender's address. */
export const mailboxAddress = () => parseAddress(env.MAIL_REPLY_TO || from()).address;

/* ZeptoMail */

const ZEPTO_TIMEOUT_MS = 30_000;

// The token is shown with its "Zoho-enczapikey " prefix in some screens and without it in others.
const zeptoAuth = () => (/^zoho-enczapikey\s/i.test(env.ZEPTOMAIL_TOKEN) ? env.ZEPTOMAIL_TOKEN : `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`);

/** ZeptoMail's reason for a refusal, without the request's content (it can hold a shopper's email). */
const zeptoError = (status, body) => {
    const e = body?.error;
    const detail = e?.details?.map((d) => [d.code, d.message, d.target].filter(Boolean).join(' ')).join('; ');
    const error = new Error(`ZeptoMail refused the email (${status}): ${[e?.code, e?.message, detail].filter(Boolean).join(' · ') || 'no reason given'}`);
    error.status = status;
    return error;
};

const sendWithZepto = async ({ to, bcc, subject, text, html, attachments }) => {
    const sender = parseAddress(from());
    const replyTo = env.MAIL_REPLY_TO ? parseAddress(env.MAIL_REPLY_TO) : null;
    const response = await fetch(env.ZEPTOMAIL_API_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: zeptoAuth() },
        body: JSON.stringify({
            from: { address: sender.address, ...(sender.name ? { name: sender.name } : {}) },
            to: [{ email_address: { address: to } }],
            ...(bcc ? { bcc: [{ email_address: { address: bcc } }] } : {}),
            subject,
            ...(html ? { htmlbody: html } : {}),
            ...(text ? { textbody: text } : {}),
            ...(replyTo ? { reply_to: [{ address: replyTo.address, ...(replyTo.name ? { name: replyTo.name } : {}) }] } : {}),
            ...(attachments?.length
                ? { attachments: attachments.map((a) => ({ name: a.filename, mime_type: a.contentType, content: Buffer.from(a.content).toString('base64') })) }
                : {}),
        }),
        signal: AbortSignal.timeout(ZEPTO_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw zeptoError(response.status, body);
    return body?.request_id ?? '';
};

/* Zoho Mail SMTP */

let transport = null;

const getTransport = () => {
    transport ??= nodemailer.createTransport({
        host: env.ZOHO_SMTP_HOST,
        port: env.ZOHO_SMTP_PORT,
        // 465 is SSL from the start; 587 upgrades with STARTTLS.
        secure: env.ZOHO_SMTP_PORT === 465,
        auth: { user: env.ZOHO_SMTP_USER, pass: env.ZOHO_SMTP_PASSWORD },
        // Reuse one connection for a run of emails rather than signing in for each.
        pool: true,
        maxConnections: 1,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
    });
    return transport;
};

const sendWithSmtp = async ({ to, bcc, subject, text, html, attachments }) => {
    const info = await getTransport().sendMail({
        from: from(),
        to,
        ...(bcc ? { bcc } : {}),
        subject,
        text,
        html,
        ...(attachments?.length ? { attachments } : {}),
        ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    });
    return info.messageId;
};

/**
 * Send one email. Throws on failure so the caller can retry it.
 * @param {{ to: string, bcc?: string, subject: string, text: string, html: string, attachments?: { filename: string, content: Buffer, contentType: string }[] }} email
 * @returns {Promise<string>} the provider's id for it
 */
export const sendMail = (email) => (env.ZEPTOMAIL_TOKEN ? sendWithZepto(email) : sendWithSmtp(email));

/** Check the SMTP mailbox can be reached and signed in to (ZeptoMail has no such check: send a test email). */
export const verifyMail = () => getTransport().verify();
