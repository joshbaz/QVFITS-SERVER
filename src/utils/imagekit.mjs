import { env } from '../env.mjs';
import { AppError } from './AppError.js';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
// The private key is the username, with no password (ImageKit's API auth).
const auth = () => `Basic ${Buffer.from(`${env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}`;

// Production's photos live under /qvfits; everything else under /qvfits-dev, so the production
// clean-up (services/media/cleanup.mjs) never sees, or deletes, a development photo.
export const UPLOAD_ROOT = env.NODE_ENV === 'production' ? '/qvfits' : '/qvfits-dev';

/** The widths the shop asks ImageKit for; it resizes on request. */
const LADDER = [400, 800, 1200];

/**
 * Upload one image to ImageKit under <UPLOAD_ROOT>/<folder> and return it as the
 * client's Photo. Only the server holds the private key; the browser never
 * talks to ImageKit's upload API directly.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @param {string} folder
 */
export const uploadImage = async (file, folder) => {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    form.append('fileName', file.originalname || 'photo.webp');
    form.append('folder', `${UPLOAD_ROOT}/${folder}`);
    form.append('useUniqueFileName', 'true');

    let response;
    try {
        response = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: auth() }, body: form, signal: AbortSignal.timeout(30000) });
    } catch (error) {
        console.error('ImageKit upload failed:', error.message);
        throw new AppError('The photo could not be uploaded. Check the connection and try again.', 502, { code: 'UPLOAD_FAILED' });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error('ImageKit upload refused:', response.status, body?.message);
        throw new AppError('The photo could not be uploaded. Try again, or use a different photo.', 502, { code: 'UPLOAD_FAILED' });
    }

    const { fileId, url, width, height } = body;
    return {
        id: fileId,
        url,
        width,
        height,
        // Only sizes the photo can fill; a small photo is offered at its own width.
        widths: LADDER.filter((w) => w < width).concat(width),
        colorId: null,
    };
};
