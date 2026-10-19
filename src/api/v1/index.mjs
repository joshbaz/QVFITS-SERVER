import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';
import adminAuth from './auth/adminAuth.mjs';
import team from './admin/team.mjs';
import catalog from './catalog/index.mjs';
import catalogAttributes from './admin/catalog/attributes.mjs';
import catalogContent from './admin/catalog/content.mjs';
import catalogProducts from './admin/catalog/products.mjs';
import uploads from './admin/uploads.mjs';

const router = express.Router();
const endpoints = [
    { path: '/auth/admin', router: adminAuth },
    { path: '/admin/team', router: team },
    { path: '/catalog', router: catalog },
    { path: '/admin/catalog/products', router: catalogProducts },
    { path: '/admin/catalog', router: catalogAttributes },
    { path: '/admin/catalog', router: catalogContent },
    { path: '/admin/uploads', router: uploads },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;