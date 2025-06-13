// utils/mediaUtils.js
const mime = require('mime-types');
const fs = require('fs').promises;
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { MessageMedia } = require('whatsapp-web.js');

const MAX_MEDIA_SIZE = 10 * 1024 * 1024; // 10MB

const extractMediaPath = (message) => {
    const mediaPathRegex = /(\b[A-Za-z]:\\[^ ]+\b)/g;
    const mediaPaths = message.match(mediaPathRegex);
    const cleanMessage = message.replace(mediaPathRegex, '').trim();
    return {
        mediaPath: mediaPaths ? mediaPaths[0] : null,
        cleanMessage
    };
};

const createMessageMedia = async (mediaPath, message) => {
    try {
        let media;
        let mediaBuffer;
        let mediaType = mime.lookup(mediaPath) || 'application/octet-stream';

        if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
            const response = await fetch(mediaPath);
            if (!response.ok) {
                throw new Error(`Failed to fetch media from URL: ${response.statusText}`);
            }

            mediaBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            const absolutePath = path.isAbsolute(mediaPath)
            ? mediaPath
            : path.join(__dirname, '..', '..', '..', mediaPath);
            console.log(`Resolving media path: ${absolutePath}`); // Added logging
            mediaBuffer = await fs.readFile(absolutePath);
            console.log(`Successfully read media file: ${absolutePath}`); // Added logging
        }

        if (mediaBuffer.length > MAX_MEDIA_SIZE) {
            throw new Error('Media file size exceeds the maximum allowed limit of 10MB');
        }

        media = new MessageMedia(mediaType, mediaBuffer.toString('base64'), path.basename(mediaPath));
        return { media, caption: message };
    } catch (error) {
        console.error(`Error in createMessageMedia: ${error.message}`); // Added logging
        throw new Error(`Failed to create media: ${error.message}`);
    }
};

module.exports = {
    extractMediaPath,
    createMessageMedia
};
