import express from 'express';
import multer from 'multer';

import { AppError } from '../../../utils/AppError.js';
import { uploadImage } from '../../../utils/imagekit.mjs';
import { requireAdmin } from '../../../middleware/adminAuth.mjs';
import { can } from '../../../utils/permissions.mjs';

/**
 * Photo uploads for products and for category and menu tiles. The browser has
 * already shrunk the photo to a 1200px WebP; this checks it and hands it to
 * ImageKit, in a folder named for what it is for.
 */
const router = express.Router();

const TYPES = new Set(['image/webp', 'image/jpeg', 'image/png', 'image/avif']);
// Well above a 1200px WebP (about 200 KB), well below a raw phone photo.
const MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, done) => done(TYPES.has(file.mimetype) ? null : new AppError('Upload a JPEG, PNG, WebP or AVIF photo.', 422), TYPES.has(file.mimetype)),
});

// Each folder is guarded by the module whose pages upload to it.
const FOLDER_MODULE = { products: 'products', categories: 'categories' };

// A photo for products needs Products edit access; for category and menu tiles, Categories.
const canUploadTo = (req, res, next) => {
    const module = FOLDER_MODULE[req.body.folder];
    if (!module) return next(new AppError('Say what the photo is for.', 422));
    if (!can(req.admin, module, 'edit')) return next(new AppError('Your role does not allow this. Ask the owner for access.', 403));
    next();
};

// multer's own errors (too big, too many) become the API's error shape.
const receive = (req, res, next) => upload.single('file')(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') return next(new AppError('That photo is over 5 MB. Try a smaller one.', 413));
    if (error && !(error instanceof AppError)) return next(new AppError('That upload could not be read. Try again.', 400));
    next(error);
});

// The folder is a form field, so the permission check runs once multer has read the form.
router.post('/', requireAdmin, receive, canUploadTo, async (req, res) => {
    if (!req.file) throw new AppError('Choose a photo to upload.', 422);
    res.status(201).json({ data: await uploadImage(req.file, req.body.folder) });
});

export default router;
