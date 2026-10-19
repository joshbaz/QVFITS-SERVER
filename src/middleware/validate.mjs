import { AppError } from '../utils/AppError.js';

/**
 * Parse req.body with a zod schema. A failure is a 422 whose details carry
 * `fieldErrors`, keyed by field, which the client's forms show beside each input.
 * @param {import('zod').ZodType} schema
 */
export default function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body ?? {});
        if (!result.success) {
            const fieldErrors = {};
            for (const issue of result.error.issues) {
                const key = issue.path.join('.') || '_';
                (fieldErrors[key] ??= []).push(issue.message);
            }
            const first = result.error.issues[0]?.message ?? 'Check the form and try again.';
            return next(new AppError(first, 422, { details: { fieldErrors } }));
        }
        req.body = result.data;
        next();
    };
}
