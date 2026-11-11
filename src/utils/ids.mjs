import crypto from 'crypto';

/** A new row id in the client's style: cus_…, ord_…, txn_…, ret_…. */
export const newRowId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// No 0/O or 1/I, so a reference read out over WhatsApp can't be misheard.
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The reference a shopper quotes: QV- and six characters, short enough to read out on a call. */
export const newOrderRef = () => `QV-${Array.from(crypto.randomBytes(6), (b) => REF_CHARS[b % REF_CHARS.length]).join('')}`;

/** The last nine digits of a phone number, so +256 772 410 218 and 0772410218 are the same one. */
export const phoneDigits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-9);

export const normalEmail = (email) => String(email ?? '').trim().toLowerCase();
