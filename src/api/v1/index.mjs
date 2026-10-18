import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';

const router = express.Router();
const endpoints = [

];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;