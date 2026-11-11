import prisma from '../../utils/db.mjs';
import { phoneDigits } from '../../utils/ids.mjs';

// A cancelled or refunded order hands its code's use back.
const RELEASED = ['cancelled', 'refunded'];

const ordersWith = (code) => prisma.order.findMany({
    where: { discountCode: { equals: code, mode: 'insensitive' }, status: { notIn: RELEASED } },
    select: { customerId: true, phoneDigits: true, total: true, discount: true },
});

/** Uses of a code, overall or by one customer (their account, else their phone). */
const usesOf = async (code, who) => {
    const list = await ordersWith(code);
    if (!who) return list.length;
    const phone = who.phone ? phoneDigits(who.phone) : null;
    return list.filter((o) => (who.customerId && o.customerId === who.customerId) || (phone && o.phoneDigits === phone)).length;
};

/** A code with its use and what it did, for the admin. Worked out from orders, never stored. */
export const discountView = async (d) => {
    const list = await ordersWith(d.code);
    return {
        ...d,
        usedCount: list.length,
        orders: list.length,
        customers: new Set(list.map((o) => o.customerId ?? o.phoneDigits)).size,
        revenue: list.reduce((n, o) => n + o.total, 0),
        given: list.reduce((n, o) => n + o.discount, 0),
    };
};

const NONE = { discount: null, amount: 0, freeShipping: false };

/**
 * What a code is worth on a priced bag, or why it does not apply: active, in
 * date, under its limits, over its minimum spend, covering at least one line.
 * Ported from the client's discountsApi; codes ignore case.
 * @param {string|undefined} code
 * @param {{ productId: string, price: number, qty: number }[]} lines - priced at what the shopper pays
 * @param {{ id: string, price: number, categoryId: string }[]} products
 * @param {{ customerId?: string, phone?: string }} [who]
 */
export const applyDiscount = async (code, lines, products, who) => {
    if (!code?.trim()) return NONE;
    const d = await prisma.discount.findFirst({ where: { code: { equals: code.trim(), mode: 'insensitive' } } });
    const fail = (reason) => ({ ...NONE, reason });
    if (!d || !d.active) return fail('That code is not valid.');
    const now = new Date();
    if (d.startsAt && d.startsAt > now) return fail('That code is not active yet.');
    if (d.endsAt && d.endsAt < now) return fail('That code has expired.');
    if (d.usageLimit !== null && (await usesOf(d.code)) >= d.usageLimit) return fail('That code has been used up.');
    if (d.perCustomerLimit !== null && who && (who.customerId || who.phone) && (await usesOf(d.code, who)) >= d.perCustomerLimit) {
        return fail('You have already used that code.');
    }

    const productOf = (l) => products.find((p) => p.id === l.productId);
    // A piece already on sale only takes the code when the code says so, so a code never stacks on the sale by accident.
    const onSale = (l) => {
        const p = productOf(l);
        return Boolean(p && l.price < p.price);
    };
    const covered = lines.filter((l) => {
        if (d.onSaleItems === false && onSale(l)) return false;
        if (d.appliesTo.scope === 'all') return true;
        if (d.appliesTo.scope === 'products') return d.appliesTo.ids.includes(l.productId);
        return Boolean(productOf(l) && d.appliesTo.ids.includes(productOf(l).categoryId));
    });
    if (!covered.length) {
        return fail(d.onSaleItems === false && lines.some(onSale) ? "That code doesn't work on pieces already on sale." : 'That code does not cover anything in your bag.');
    }

    const base = covered.reduce((sum, l) => sum + l.price * l.qty, 0);
    const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    if (subtotal < d.minSpend) return fail(`Spend ${d.minSpend.toLocaleString('en-UG')} UGX or more to use that code.`);

    if (d.type === 'free_shipping') return { discount: d, amount: 0, freeShipping: true };
    const amount = d.type === 'fixed' ? Math.min(d.value, base) : Math.round((base * d.value) / 100);
    return { discount: d, amount, freeShipping: false };
};
