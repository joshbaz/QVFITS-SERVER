/**
 * Sends one test email the way the server sends every email (ZeptoMail if
 * its token is set, else Zoho Mail's SMTP), and prints what happened: the
 * provider's id, or its exact reason for refusing.
 *
 *   yarn mail:test you@example.com
 */
import { env } from '../src/env.mjs';
import { isMailConfigured, mailRoute, sendMail } from '../src/services/emails/zohoMail.js';

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.log('Say who to send it to: yarn mail:test you@example.com');
    process.exit(1);
}
if (!isMailConfigured()) {
    console.log('No email is set up: put ZEPTOMAIL_TOKEN (or the ZOHO_SMTP_* settings) in .env first.');
    process.exit(1);
}

const route = mailRoute();
console.log(`Sending through ${route === 'zeptomail' ? `ZeptoMail (${new URL(env.ZEPTOMAIL_API_URL).host})` : `Zoho SMTP (${env.ZOHO_SMTP_HOST}:${env.ZOHO_SMTP_PORT})`}, from ${env.MAIL_FROM || env.ZOHO_SMTP_USER}…`);
try {
    const id = await sendMail({
        to,
        subject: 'QVFITS test email',
        text: 'This is a test from the QVFITS server. If you can read it, email is working.',
        html: '<div style="font-family:Arial,sans-serif;color:#111"><h1 style="font-size:20px">It works</h1><p>This is a test from the QVFITS server. If you can read it, email is working.</p></div>',
    });
    console.log(`Sent${id ? ` (id ${id})` : ''}. Check the inbox, and the spam folder.`);
    process.exit(0);
} catch (error) {
    console.log(`Not sent: ${error.message}`);
    if (route === 'smtp' && /timeout|ETIMEDOUT|ECONNREFUSED/i.test(error.message)) {
        console.log('A timeout here usually means the host blocks the SMTP ports (DigitalOcean does): use ZEPTOMAIL_TOKEN instead.');
    }
    process.exit(1);
}
