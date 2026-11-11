import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { eraseSubscriberByEmail } from '../newsletter/subscribers.mjs';

/**
 * Closes an account. Orders and returns stay for the shop's books (the law
 * needs them) but lose the person: name, phone, email, address and note are
 * blanked. Their newsletter record (and its consent history) is deleted too.
 */
export const eraseCustomer = async (customerId) => {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError('We could not find that account.', 404);
    await prisma.$transaction([
        prisma.order.updateMany({
            where: { customerId },
            data: { customerId: null, name: 'Closed account', phone: '', phoneDigits: '', email: null, address: null, note: null },
        }),
        prisma.returnRequest.updateMany({ where: { customerId }, data: { customerId: null, name: 'Closed account' } }),
        prisma.customerSession.deleteMany({ where: { customerId } }),
        prisma.customer.delete({ where: { id: customerId } }),
    ]);
    await eraseSubscriberByEmail(customer.email);
    return customer;
};
