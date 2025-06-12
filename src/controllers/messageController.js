const path = require('path');
const {
  SERVICES_DIR,
  MEDIA_DIR,
  LOGGER_DIR,
  CONFIG_DIR
} = require('../config/paths');

const { getClient } = require(path.join(SERVICES_DIR, 'clientService'));
const { extractMediaPath, createMessageMedia } = require(path.join(MEDIA_DIR, 'mediaUtils'));
const { logMessageStatus } = require(path.join(LOGGER_DIR, 'logUtils'));
const { getConfig } = require(path.join(CONFIG_DIR, 'configLoader'));
const wrap = require('../middlewares/asyncWrapper');


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

// Function to process the campaign queue with proper delays
const processCampaignQueue = async (clientId) => {
    const clientEntry = getClient(clientId);
    if (!clientEntry || clientEntry.isProcessingQueue || clientEntry.campaignQueue.length === 0) return;

    clientEntry.isProcessingQueue = true;
    const { campaignQueue, process: clientProcess } = clientEntry;
    const config = getConfig(); // Call getConfig once
    const { MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX, REST_DELAY_MIN, REST_DELAY_MAX } = config;

    let messageCount = 0;

    while (campaignQueue.length > 0) {
        const messageData = campaignQueue.shift();
        try {
            await sendMessageToClient(
                clientProcess,
                messageData.phoneNumber,
                messageData.message,
                messageData.mediaPath,
                clientId,
                messageData.leadID // Ensure leadID is included
            );
        } catch (error) {
            console.error(`Error processing campaign queue for ${messageData.phoneNumber}:`, error);
        }

        messageCount++;
        // Determine the delay based on message count
        const delay = getDelay(messageCount, config); // Use the cached config
        
        // Pause processing for the calculated delay
        await delayExecution(delay);
    }

    clientEntry.isProcessingQueue = false;
};

// Utility functions for delay calculation and execution
const getDelay = (messageCount, config) => {
  const { REST_DELAY_MIN, REST_DELAY_MAX, MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX, MESSAGE_LIMIT_BEFORE_DELAY } = config;
  return (messageCount % MESSAGE_LIMIT_BEFORE_DELAY === 0) // Use the new configurable limit
      ? Math.random() * (REST_DELAY_MAX - REST_DELAY_MIN) + REST_DELAY_MIN
      : Math.random() * (MESSAGE_DELAY_MAX - MESSAGE_DELAY_MIN) + MESSAGE_DELAY_MIN;
};

const delayExecution = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    const clientEntry = getClient(clientID);
    if (!clientEntry || !clientEntry.isActive) {
        return res.status(400).json({ message: 'Failed to send message', status: 'undelivered' });
    }

    let finalMediaPath = mediaPath;
    let message = messageText || "";

    // Extract media path if not provided directly
    if (!finalMediaPath) {
        const extracted = extractMediaPath(message);
        finalMediaPath = extracted.mediaPath;
        message = extracted.cleanMessage;
    }

    // If the request is from the 'sender' module, add it to the campaign queue
    if (requestData.module_id === 'sender') {
        clientEntry.campaignQueue.push({ phoneNumber, message, mediaPath: finalMediaPath, leadID });
        processCampaignQueue(clientID);
        return res.json({ message: 'Message added to campaign queue' });
    }

    // Otherwise, send the message immediately
    await sendMessageToClient(clientEntry.process, phoneNumber, message, finalMediaPath, clientID, leadID);
    return res.json({ message: 'Message sent successfully', status: 'delivered', OWNER_ID: leadID });
});