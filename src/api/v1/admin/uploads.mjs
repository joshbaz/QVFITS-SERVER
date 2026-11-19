import express from 'express';
import multer from 'multer';

import { AppError } from '../../../utils/AppError.js';
import { uploadImage, uploadVideo } from '../../../utils/imagekit.mjs';
import { requireAdmin } from '../../../middleware/adminAuth.mjs';
import { can } from '../../../utils/permissions.mjs';

/**
 * Uploads for products, category and menu tiles, and the home page and offers
 * (content). A photo has already been shrunk in the browser to a WebP; this
 * checks it and hands it to ImageKit, in a folder named for what it is for.
 * The home page's Seen on you reels also take a short video, sent as it is.
 */
const router = express.Router();

const IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
// Well above a resized WebP (a 2000px hero is under 1 MB), well below a raw phone photo.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// A reel of under half a minute; the client stops anything bigger before it is sent.
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const isVideo = (file) => VIDEO_TYPES.has(file.mimetype);

const upload = multer({
    storage: multer.memoryStorage(),
    // The larger of the two limits; a photo's own limit is checked once it has arrived.
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
    fileFilter: (req, file, done) => {
        const ok = IMAGE_TYPES.has(file.mimetype) || isVideo(file);
        done(ok ? null : new AppError('Upload a JPEG, PNG, WebP or AVIF photo, or an MP4, WebM or MOV clip.', 422), ok);
    },
});

// Each folder is guarded by the module whose pages upload to it. Content is the home page and offers.
const FOLDER_MODULE = { products: 'products', categories: 'categories', content: 'offers' };
// Only the home page's reels take a video.
const VIDEO_FOLDERS = new Set(['content']);

// A photo for products needs Products edit access; for category and menu tiles, Categories; for the home page, Offers.
const canUploadTo = (req, res, next) => {
    const module = FOLDER_MODULE[req.body.folder];
    if (!module) return next(new AppError('Say what the photo is for.', 422));
    if (!can(req.admin, module, 'edit')) return next(new AppError('Your role does not allow this. Ask the owner for access.', 403));
    next();
};

// multer's own errors (too big, too many) become the API's error shape.
const receive = (req, res, next) => upload.single('file')(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') return next(new AppError('That file is over 30 MB. Trim the clip and try again.', 413));
    if (error && !(error instanceof AppError)) return next(new AppError('That upload could not be read. Try again.', 400));
    next(error);
});

// The folder is a form field, so the permission check runs once multer has read the form.
router.post('/', requireAdmin, receive, canUploadTo, async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError('Choose a photo to upload.', 422);
    if (isVideo(file)) {
        if (!VIDEO_FOLDERS.has(req.body.folder)) throw new AppError('Only the home page takes a video. Upload a photo here.', 422);
        return res.status(201).json({ data: await uploadVideo(file, req.body.folder) });
    }
    if (file.size > MAX_IMAGE_BYTES) throw new AppError('That photo is over 5 MB. Try a smaller one.', 413);
    res.status(201).json({ data: await uploadImage(file, req.body.folder) });
});

export default router;
