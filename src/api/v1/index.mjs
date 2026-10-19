import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';
import adminAuth from './auth/adminAuth.mjs';
import team from './admin/team.mjs';

const router = express.Router();
const endpoints = [
    { path: '/auth/admin', router: adminAuth },
    { path: '/admin/team', router: team },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;