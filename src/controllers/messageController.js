const path = require('path');
const {
  SERVICES_DIR,
  UTILS_DIR,
} = require('../config/paths');

const {
  getClient,
  terminateClient,
  getAllClients,
  terminateAllClientsService,
  initializeClient,
  sendImmediateMessage
} = require(path.join(SERVICES_DIR, 'clientService'));
const { extractMediaPath, createMessageMedia } = require(path.join(UTILS_DIR, 'mediaUtils'));
const { logMessageStatus } = require(path.join(UTILS_DIR, 'logUtils'));
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

    // Client must exist and be fully ready (session saved) to send messages.
    const clientEntry = getClient(clientID);
    if (!clientEntry || !clientEntry.isReady) {
        const statusMessage = !clientEntry ? 'Client not initialized' : 'Client is not ready yet (session may be synchronizing)';
        return res.status(400).json({ message: `Failed to send message: ${statusMessage}`, status: 'undelivered' });
    }

    let finalMediaPath = mediaPath;
    let message = messageText || "";

    // Extract media path if not provided directly
    if (!finalMediaPath && message) {
        const extracted = extractMediaPath(message);
        finalMediaPath = extracted.mediaPath;
        message = extracted.cleanMessage;
    }

    const messageData = { phoneNumber, message, mediaPath: finalMediaPath, userId: clientID, leadID };

    // If the request is from the 'sender' module, add it to the Redis campaign queue
    if (requestData.module_id === 'sender') {
        const queueKey = `whatsapp:queue:${clientID}`;
        await redis.rpush(queueKey, JSON.stringify(messageData));
        logMessageStatus(clientID, phoneNumber, 'queued', leadID);
        return res.json({ message: 'Message added to campaign queue in Redis', status: 'queued', OWNER_ID: leadID });
    }

    // Otherwise, send the message immediately
    try {
        await sendImmediateMessage(clientID, messageData);
        logMessageStatus(clientID, phoneNumber, 'sent', leadID);
        return res.json({ message: 'Message sent successfully', status: 'delivered', OWNER_ID: leadID });
    } catch (error) {
        logMessageStatus(clientID, phoneNumber, 'failed', leadID, error.message);
        return res.status(500).json({ message: `Failed to send immediate message: ${error.message}`, status: 'undelivered' });
    }
});