const CODES = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE',
    429: 'RATE_LIMITED',
};

export const codeFor = (status) => CODES[status] ?? 'INTERNAL_ERROR';

/**
 * An error the client should see as-is. The error middleware turns it into
 * `{ error: { code, message, details? } }`, the one failure shape the client reads.
 */
export class AppError extends Error {
    /**
     * @param {string} message - Shown to the person, so write it for them
     * @param {number} [statusCode]
     * @param {{ code?: string, details?: object }} [options]
     */
    constructor(message, statusCode = 400, { code, details } = {}) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code ?? codeFor(statusCode);
        this.details = details;
    }
}
