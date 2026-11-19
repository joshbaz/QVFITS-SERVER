import { env } from '../env.mjs';
import { AppError } from './AppError.js';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
// The private key is the username, with no password (ImageKit's API auth).
const auth = () => `Basic ${Buffer.from(`${env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}`;

// Production's photos live under /qvfits; everything else under /qvfits-dev, so the production
// clean-up (services/media/cleanup.mjs) never sees, or deletes, a development photo.
export const UPLOAD_ROOT = env.NODE_ENV === 'production' ? '/qvfits' : '/qvfits-dev';

/** The widths the shop asks ImageKit for; it resizes on request. A wide hero photo also gets 1600 and its own width. */
const LADDER = [400, 800, 1200, 1600];

/**
 * Send one file to ImageKit under <UPLOAD_ROOT>/<folder> and return ImageKit's
 * answer. `what` names the file in the error a person sees.
 */
const send = async (file, folder, { fallbackName, what, timeoutMs }) => {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    form.append('fileName', file.originalname || fallbackName);
    form.append('folder', `${UPLOAD_ROOT}/${folder}`);
    form.append('useUniqueFileName', 'true');

    let response;
    try {
        response = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: auth() }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        console.error('ImageKit upload failed:', error.message);
        throw new AppError(`The ${what} could not be uploaded. Check the connection and try again.`, 502, { code: 'UPLOAD_FAILED' });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error('ImageKit upload refused:', response.status, body?.message);
        throw new AppError(`The ${what} could not be uploaded. Try again, or use a different ${what}.`, 502, { code: 'UPLOAD_FAILED' });
    }
    return body;
};

/**
 * Upload one image to ImageKit and return it as the client's Photo. Only the
 * server holds the private key; the browser never talks to ImageKit's upload
 * API directly.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @param {string} folder
 */
export const uploadImage = async (file, folder) => {
    const { fileId, url, width, height } = await send(file, folder, { fallbackName: 'photo.webp', what: 'photo', timeoutMs: 30_000 });
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

/**
 * Upload one short video (a Seen on you reel) to ImageKit as it is, and return
 * the address it is served from. Up to 30 MB, so it is given longer than a photo.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @param {string} folder
 * @returns {Promise<{ id: string, url: string }>}
 */
export const uploadVideo = async (file, folder) => {
    const { fileId, url } = await send(file, folder, { fallbackName: 'reel.mp4', what: 'clip', timeoutMs: 120_000 });
    return { id: fileId, url };
};
