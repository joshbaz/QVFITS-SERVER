/**
 * Log each request's method, URL, status and duration once the response finishes.
 */
export default function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
}
