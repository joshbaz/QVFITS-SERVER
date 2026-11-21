import prisma from '../../utils/db.mjs';
// The ways to pay checkout knows about. The ids are fixed: Pesapal takes mtn, airtel and card,
// and whatsapp is the hand-off where the shop confirms stock first.
import standard from '../../data/payment-methods.json';

/**
 * Add any standard payment method the database is missing, so a new shop
 * has them in Settings > Payments to switch on or off. Ones already there
 * keep the admin's names, help text and on/off, and are never overwritten.
 */
export const ensurePaymentMethods = async () => {
    const have = new Set((await prisma.paymentMethod.findMany({ select: { id: true } })).map((m) => m.id));
    const missing = standard.filter((m) => !have.has(m.id));
    if (!missing.length) return 0;
    await prisma.paymentMethod.createMany({ data: missing });
    console.info(`Payment methods: added ${missing.map((m) => m.label).join(', ')}`);
    return missing.length;
};
