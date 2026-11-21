import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';

/** A small photo for an email, from ImageKit (or the older /photos store). */
export const emailImage = (photo, width = 400) => {
    if (!photo) return null;
    if (photo.url?.startsWith('https://ik.imagekit.io/')) return `${photo.url}?tr=w-${width},f-auto,q-70`;
    if (photo.url) return `${photo.url}?w=${width}&auto=format&q=70`;
    return `${env.APP_URL}/photos/${photo.id}-400.webp`;
};

/**
 * An order as the email layout draws it (templates.mjs, meta.order): each
 * piece with its photo in the colour bought, the totals, where it goes and
 * how it is paid. Kept on the Outbox row, so a retry sends the same summary.
 */
export const orderSummary = async (order) => {
    const ids = [...new Set(order.lines.map((l) => l.productId))];
    const [products, zone, method] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, photos: true } }),
        prisma.shippingZone.findUnique({ where: { id: order.region }, select: { name: true } }),
        prisma.paymentMethod.findUnique({ where: { id: order.payment }, select: { label: true } }),
    ]);
    const photoFor = (l) => {
        const photos = products.find((p) => p.id === l.productId)?.photos ?? [];
        return photos.find((ph) => l.colorId && ph.colorId === l.colorId) ?? photos[0];
    };
    return {
        ref: order.ref,
        placedAt: order.createdAt,
        lines: order.lines.map((l) => ({ name: l.name, color: l.color, size: l.size, qty: l.qty, amount: l.price * l.qty, image: emailImage(photoFor(l), 160) })),
        subtotal: order.subtotal,
        kitSaving: order.kitSaving || 0,
        discount: order.discount || 0,
        discountCode: order.discountCode || null,
        delivery: order.delivery,
        total: order.total,
        customer: { name: order.name, phone: order.phone, email: order.email || null },
        area: zone?.name || order.region,
        address: order.address || null,
        note: order.note || null,
        payment: method?.label || order.payment,
        paymentStatus: order.paymentStatus,
        source: order.source,
    };
};
