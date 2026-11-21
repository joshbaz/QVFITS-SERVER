import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { redis } from '../../utils/redis.mjs';

/**
 * Pesapal API 3.0 (developer.pesapal.com): MTN MoMo, Airtel Money and cards
 * on Pesapal's own page, so the shop never sees a card or a PIN. Ported from
 * artistry360's services/payments/pesapal.mjs.
 *
 * Nothing here decides that a payment happened: `getStatus` asks Pesapal,
 * and only that answer moves an order on (services/payments/payments.mjs).
 */

const BASES = {
    sandbox: 'https://cybqa.pesapal.com/pesapalv3/api',
    live: 'https://pay.pesapal.com/v3/api',
};
const BASE = env.PESAPAL_BASE_URL ?? BASES[env.PESAPAL_ENV];
const TIMEOUT_MS = 15_000;

export const IPN_URL = env.PESAPAL_IPN_URL ?? (env.API_URL ? `${env.API_URL.replace(/\/+$/, '')}/api/v1/payments/pesapal/ipn` : null);

export const isPesapalConfigured = () => Boolean(env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET);

/** Which keys are in use, kept on each payment: a sandbox payment can't be looked up with live keys. */
export const PESAPAL_ENV = env.PESAPAL_ENV;

const unreachable = () => new AppError("We couldn't reach Pesapal just now. Try again in a moment.", 502, { code: 'PAYMENT_PROVIDER_UNAVAILABLE' });

// `answerErrors`: Pesapal's own error reply (an unknown order, say) comes back as data, not as "unreachable".
const call = async (method, path, { body, token, answerErrors = false } = {}) => {
    let response;
    try {
        response = await fetch(`${BASE}${path}`, {
            method,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        console.error(`Pesapal ${path} unreachable:`, error.message);
        throw unreachable();
    }
    const data = await response.json().catch(() => null);
    if (answerErrors && data?.error && (data.error.code || data.error.message)) return data;
    if (!response.ok || !data) {
        console.error(`Pesapal ${path} answered ${response.status}`);
        throw unreachable();
    }
    return data;
};

// Pesapal tokens last five minutes; one is shared until shortly before it runs out.
let cached = null;

const accessToken = async () => {
    if (cached && cached.expiresAt - Date.now() > 30_000) return cached.token;
    if (!isPesapalConfigured()) throw new AppError('Online payments are not set up yet, so there is nothing to check with Pesapal.', 503, { code: 'PAYMENTS_NOT_CONFIGURED' });
    const data = await call('POST', '/Auth/RequestToken', { body: { consumer_key: env.PESAPAL_CONSUMER_KEY, consumer_secret: env.PESAPAL_CONSUMER_SECRET } });
    if (!data.token) {
        console.error('Pesapal refused the consumer key:', data.error?.code ?? data.message);
        throw unreachable();
    }
    cached = { token: data.token, expiresAt: Date.parse(data.expiryDate) || Date.now() + 4 * 60_000 };
    return cached.token;
};

/**
 * The IPN id every checkout names. Registered once per URL and remembered in
 * Redis, because each registration makes a new id at Pesapal.
 */
let ipnId = null;
const IPN_KEY = `qvfits:pesapal:${env.PESAPAL_ENV}:ipn:${IPN_URL}`;

const notificationId = async () => {
    if (ipnId) return ipnId;
    if (!IPN_URL) throw new AppError('Set API_URL (or PESAPAL_IPN_URL) so Pesapal can tell the shop about payments.', 503, { code: 'PAYMENTS_NOT_CONFIGURED' });
    ipnId = await redis.get(IPN_KEY).catch(() => null);
    if (ipnId) return ipnId;
    const token = await accessToken();
    const existing = await call('GET', '/URLSetup/GetIpnList', { token });
    ipnId = Array.isArray(existing) ? existing.find((i) => i.url === IPN_URL && i.ipn_status === 1)?.ipn_id : null;
    if (!ipnId) {
        const registered = await call('POST', '/URLSetup/RegisterIPN', { token, body: { url: IPN_URL, ipn_notification_type: 'GET' } });
        ipnId = registered.ipn_id;
        if (!ipnId) throw unreachable();
    }
    await redis.set(IPN_KEY, ipnId).catch(() => {});
    return ipnId;
};

/**
 * Open a checkout at Pesapal. Pesapal sends the shopper back to
 * `callbackUrl?OrderTrackingId=…&OrderMerchantReference=…`, so the URL must
 * carry no query string of its own.
 * @param {{ reference: string, amountUGX: number, description: string, callbackUrl: string, payer: { name?: string, phone?: string, email?: string } }} order
 * @returns {Promise<{ trackingId: string, redirectUrl: string }>}
 */
export const submitOrder = async ({ reference, amountUGX, description, callbackUrl, payer = {} }) => {
    const token = await accessToken();
    const [first, ...rest] = String(payer.name ?? '').trim().split(/\s+/);
    const data = await call('POST', '/Transactions/SubmitOrderRequest', {
        token,
        body: {
            id: reference,
            currency: 'UGX',
            amount: amountUGX,
            description: description.slice(0, 100),
            callback_url: callbackUrl,
            notification_id: await notificationId(),
            // Only fills Pesapal's form in; its page asks for anything else it needs.
            billing_address: {
                ...(payer.email ? { email_address: payer.email } : {}),
                ...(payer.phone ? { phone_number: payer.phone } : {}),
                ...(first ? { first_name: first } : {}),
                ...(rest.length ? { last_name: rest.join(' ') } : {}),
            },
        },
    });
    if (!data.order_tracking_id || !data.redirect_url) {
        console.error('Pesapal refused an order:', data.error?.code ?? data.message);
        throw unreachable();
    }
    return { trackingId: data.order_tracking_id, redirectUrl: data.redirect_url };
};

// Pesapal's status codes (GetTransactionStatus). 0 (INVALID) also covers a checkout nobody has paid yet, so it means "not yet".
const STATES = { 1: 'completed', 2: 'failed', 3: 'reversed' };

/**
 * What Pesapal says about a payment now, by its order tracking id (the
 * transaction's reference). The payer's account fields are never read.
 * @param {string} trackingId
 * @returns {Promise<{ state: 'pending' | 'completed' | 'failed' | 'reversed' | 'unknown', note: string, amount: number, currency: string, method: string, confirmationCode: string, reference: string }>}
 */
export const getStatus = async (trackingId) => {
    const token = await accessToken();
    const data = await call('GET', `/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`, { token, answerErrors: true });
    // Both come back as status 0 with an error: an unpaid checkout (payment_details_not_found)
    // and a tracking id Pesapal doesn't know. Only the first is "not paid yet".
    const raw = data.error?.code || data.error?.message ? data.error : null;
    const error = raw && raw.code !== 'payment_details_not_found' ? raw : null;
    return {
        state: error ? 'unknown' : STATES[data.status_code] ?? 'pending',
        note: String((error ? [error.code, error.message].filter(Boolean).join(': ') : data.description || raw?.message) ?? '').slice(0, 300),
        amount: Number(data.amount) || 0,
        currency: data.currency ?? '',
        method: data.payment_method ?? '',
        confirmationCode: data.confirmation_code ?? '',
        reference: data.merchant_reference ?? '',
    };
};
