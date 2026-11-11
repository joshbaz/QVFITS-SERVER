import nodemailer from 'nodemailer';
import { env } from '../../env.mjs';

/**
 * Sending through Zoho Mail's SMTP server. Only the email queue calls this
 * (services/emails/queue.mjs), so a slow or failing send never holds up a
 * shopper's request, and a failure is retried.
 */

/** Whether a Zoho mailbox is set up. Without one, emails wait in the Outbox. */
export const isMailConfigured = () => Boolean(env.ZOHO_SMTP_USER && env.ZOHO_SMTP_PASSWORD);

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

const from = () => env.MAIL_FROM || `QVFITS <${env.ZOHO_SMTP_USER}>`;

/**
 * Send one email. Throws on failure so the queue can retry it.
 * @param {{ to: string, subject: string, text: string, html: string }} email
 * @returns {Promise<string>} Zoho's message id
 */
export const sendMail = async ({ to, subject, text, html }) => {
    const info = await getTransport().sendMail({
        from: from(),
        to,
        subject,
        text,
        html,
        ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    });
    return info.messageId;
};

/** Check the mailbox can be reached and signed in to, for start-up and the admin. */
export const verifyMail = () => getTransport().verify();
