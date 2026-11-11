import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';
import adminAuth from './auth/adminAuth.mjs';
import team from './admin/team.mjs';
import catalog from './catalog/index.mjs';
import catalogAttributes from './admin/catalog/attributes.mjs';
import catalogContent from './admin/catalog/content.mjs';
import catalogProducts from './admin/catalog/products.mjs';
import uploads from './admin/uploads.mjs';
import shop from './shop/index.mjs';
import settings from './admin/settings.mjs';
import discounts from './admin/discounts.mjs';
import customerAuth from './auth/customerAuth.mjs';
import account from './account/index.mjs';
import { checkout, guestOrders } from './checkout/index.mjs';
import sales from './admin/sales.mjs';
import newsletter from './newsletter/index.mjs';
import adminNewsletter from './admin/newsletter.mjs';
import site from './site/index.mjs';
import adminSite from './admin/site.mjs';

const router = express.Router();
const endpoints = [
    { path: '/auth/admin', router: adminAuth },
    { path: '/admin/team', router: team },
    { path: '/catalog', router: catalog },
    { path: '/admin/catalog/products', router: catalogProducts },
    { path: '/admin/catalog', router: catalogAttributes },
    { path: '/admin/catalog', router: catalogContent },
    { path: '/admin/uploads', router: uploads },
    { path: '/shop', router: shop },
    { path: '/admin/settings', router: settings },
    { path: '/admin/discounts', router: discounts },
    { path: '/auth/customer', router: customerAuth },
    { path: '/account', router: account },
    { path: '/checkout', router: checkout },
    { path: '/orders', router: guestOrders },
    { path: '/newsletter', router: newsletter },
    { path: '/admin/newsletter', router: adminNewsletter },
    { path: '/site', router: site },
    { path: '/admin', router: adminSite },
    { path: '/admin', router: sales },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;