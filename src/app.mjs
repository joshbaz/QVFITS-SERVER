import * as express from "express";

import api from './api/index.js';
import compression from "compression";
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { apiLimiter, authLimiter } from './utils/rateLimits.js';
import { corsOptions } from './utils/corsOptions.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';

// Serve Swagger UI
// Get directory name in ES modules
const __dirname = path.resolve();

const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QVFITS Server Status</title>
    <style>
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background-color: #141118; /* Dark background */
            font-family: Arial, sans-serif;
        }
        .status {
            text-align: center;
            padding: 20px;
            border: 1px solid #ccc;
            border-radius: 5px;
            background-color: #1A171E; /* Background color for the status box */
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
        }
        h1 {
            color: #F2F2F2; /* Updated primary color */
        }
        p {
            color: #FFFAF6; /* Secondary white */
        }
        a {
            color: #F2F2F2; /* Updated primary color for links */
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline; /* Underline on hover */
        }
        img {
            max-width: 150px; /* Set a maximum width for the logo */
            margin-bottom: 15px; /* Add some space below the logo */
        }
    </style>
</head>
<body>
    <div class="status">
        <img src="/favicon.ico" alt="QVFITS Logo">
        <h1>QVFITS Server is Live</h1> <!-- Updated Message -->
        <p>The QVFITS server is up and running.</p>
        <p>For any inquiries, contact us at <a href="mailto:jkimbareeba@yahoo.com">jkimbareeba@yahoo.com</a></p>
    </div>
</body>
</html>`;

/**
 * @module app
 * @name customizeApp
 * @description Customize the Express app instance
 * @param {express.Application} app - The Express app instance
 * @returns {void}
 */

/**
 * Customize the Express app instance       
 * @param {express.Application} app - The Express app instance
 * @returns {void}
 */
export default function customizeApp(app) {
    // `app.set("trust proxy", 1);` is a configuration setting in Express that enables the app to trust the proxy server that is in front of it. This setting is important when the Express app is running behind a proxy server like Nginx or Apache.
    app.set("trust proxy", 1);

    // `app.use(express.json());` is setting up middleware in the Express app to parse incoming requests with JSON payloads. This middleware function parses the incoming request body and makes it available under the `req.body` property in your route handlers. It enables the Express app to handle JSON data sent in the request body of POST, PUT, and PATCH requests.
    app.use(express.json());

    // `app.use(express.urlencoded({extended: false}));` is setting up middleware in the Express app to parse incoming requests with URL-encoded payloads. This middleware function parses the incoming request body and makes it available under the `req.body` property in your route handlers. It enables the Express app to handle URL-encoded data sent in the request body of POST, PUT, and PATCH requests.
    app.use(express.urlencoded({ extended: false }));

    // `app.use(cors(corsOptions));` is setting up middleware in the Express app to enable Cross-Origin Resource Sharing (CORS). CORS is a security feature that allows web pages from one origin to access resources from another origin. The `corsOptions` object contains the configuration for the CORS middleware.
    // `corsOptions` is an object that contains the configuration for the CORS middleware.
    // `corsOptions` is an object that contains the configuration for the CORS middleware.
    app.use(cors(corsOptions));


    // Parse Cookies
    app.use(cookieParser());

    // Compress Response Bodies using gzip
    app.use(compression());

    // Serve Static Files from the public directory
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        res.status(200).send(htmlTemplate);
    });
    // Serve the Status Page
    app.get('/status', (req, res) => {
        res.status(200).send(htmlTemplate);
    });

    // Load Swagger YAML file (swagger.yaml) and serve it at /api-docs
    const swaggerDocument = YAML.load(path.join(__dirname, "src/swagger.yaml"));
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
        explorer: true,
        customCss: ".swagger-ui .topbar {display:none}",
        swaggerOptions: {
            docExpansion: 'none'
        }
    }));

    // Serve the Swagger JSON
    app.get("/api-docs.json", (req, res) => {
        res.json(swaggerDocument);
    });

    // Rate Limiting (see utils/rateLimits.js)
    app.use('/api', authLimiter);
    app.use('/api', apiLimiter);

    // API Routes
    app.use('/api', api);

    // Error Handling Middleware
    app.use((err, req, res, next) => {
        if (err.statusCode >= 400 && err.statusCode < 500) {
            let message = err.message || 'Bad Request';
            if (!message && err.statusCode === 404) {
                message = 'The requested resource was not found';
            }
            res.status(err.statusCode).json({
                status: 'error',
                message,
            });
        } else {
            console.error(err?.message || 'Internal Server Error');
            if (!err.statusCode) {
                err.statusCode = 500;
            }
            res.status(err.statusCode).json({
                status: 'error',
                message: err?.message || 'Internal Server Error',
            });
        }
    });


}

/* Security Notes
 *
 * 1. Always restrict `origin` to known, trusted domains
 * 2. Avoid using `origin: '*'` in production
 * 3. Only enable `credentials: true` if cross-origin authentication is required
 * 4. Regularly audit allowed origins and methods
 * 5. Consider implementing rate limiting alongside CORS
 */

/* Troubleshooting
 *
 * Common CORS errors and solutions:
 *
 * 1. "No 'Access-Control-Allow-Origin' header":
 *    - Verify client origin is in allowed origins list
 *    - Check for typos in domain names
 *
 * 2. Credentials issues:
 *    - Ensure `credentials: true` is set
 *    - Verify frontend includes `credentials: 'include'`
 *
 * 3. Methods not allowed:
 *    - Confirm required method is in `methods` array
 *    - Check for case sensitivity
 *
 * 4. Headers not allowed:
 *    - Verify custom headers are listed in `allowedHeaders`
 *    - Check header naming conventions
 */