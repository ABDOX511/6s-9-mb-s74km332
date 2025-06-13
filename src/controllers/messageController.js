const path = require('path');
const {
  SERVICES_DIR,
  MEDIA_DIR,
  LOGGER_DIR,
} = require('../config/paths');

const { getClient } = require(path.join(SERVICES_DIR, 'clientService'));
const { extractMediaPath, createMessageMedia } = require(path.join(MEDIA_DIR, 'mediaUtils'));
const { logMessageStatus } = require(path.join(LOGGER_DIR, 'logUtils'));
const wrap = require('../middlewares/asyncWrapper');
const redis = require('../config/redisClient'); // Import Redis client

// Function to send a message to a client
const sendMessageToClient = (clientProcess, phoneNumber, message, mediaPath, userId, leadID) => {
    return new Promise((resolve, reject) => {
        const messageHandler = (msg) => {
            if (msg.type === 'message_sent' && msg.phoneNumber === phoneNumber) {
                resolve();
                clientProcess.off('message', messageHandler); // Remove listener
            } else if (msg.type === 'message_error' && msg.phoneNumber === phoneNumber) {
                reject(new Error(msg.error));
                clientProcess.off('message', messageHandler); // Remove listener
            }
        };

        clientProcess.on('message', messageHandler);

        // Extract media path if not provided directly
        if (!mediaPath) {
            const extracted = extractMediaPath(message);
            mediaPath = extracted.mediaPath;
            message = extracted.cleanMessage;
        }

        clientProcess.send({ type: 'send_message', phoneNumber, message, mediaPath, userId, leadID });
    });
};

// Function to handle incoming send message requests
exports.sendMessage = wrap(async (req, res) => {
    const requestData = req.body.request;
    if (!requestData) {
        return res.status(400).json({ message: 'Request data is missing' });
    }

    const { properties, auth, bindings } = requestData;
    const { phone_number: rawPhoneNumber, message_text: messageText, LINK: mediaPath } = properties || {};
    const clientID = auth?.user_id;
    const leadID = bindings && bindings.length > 0 ? bindings[0].OWNER_ID : null;

    if (!rawPhoneNumber || !clientID) {
        return res.status(400).json({ message: 'Phone number or clientID is missing' });
    }

    // Format the phone number
    const phoneNumber = rawPhoneNumber.replace(/^\+/, '').replace(/\D/g, '') + '@c.us';

    if (!messageText && !mediaPath) {
        return res.status(400).json({ message: 'Message text or media path is missing' });
    }

    // Client must exist and be active to add to queue or send immediately
    const clientEntry = getClient(clientID);
    if (!clientEntry || !clientEntry.isActive) {
        return res.status(400).json({ message: 'Failed to send message: Client not active or initialized', status: 'undelivered' });
    }

    let finalMediaPath = mediaPath;
    let message = messageText || "";

    // Extract media path if not provided directly
    if (!finalMediaPath) {
        const extracted = extractMediaPath(message);
        finalMediaPath = extracted.mediaPath;
        message = extracted.cleanMessage;
    }

    // If the request is from the 'sender' module, add it to the campaign queue in Redis
    if (requestData.module_id === 'sender') {
        const messageData = { phoneNumber, message, mediaPath: finalMediaPath, userId: clientID, leadID };
        const queueKey = `whatsapp:queue:${clientID}`;
        await redis.rpush(queueKey, JSON.stringify(messageData));
        return res.json({ message: 'Message added to campaign queue in Redis' });
    }

    // Otherwise, send the message immediately
    await sendMessageToClient(clientEntry.process, phoneNumber, message, finalMediaPath, clientID, leadID);
    return res.json({ message: 'Message sent successfully', status: 'delivered', OWNER_ID: leadID });
});