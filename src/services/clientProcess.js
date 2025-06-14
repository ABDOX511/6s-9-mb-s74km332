const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { DATA_AUTH, UTILS_DIR, CONFIG_DIR } = require('../config/paths');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const redis = require('../config/redisClient'); // Import Redis client
const { getConfig } = require('../utils/configManager'); // Import config for delays

const { logClientEvent, logMessageStatus } = require(path.join(UTILS_DIR, 'logUtils.js'));
const { createMessageMedia } = require(path.join(UTILS_DIR, 'mediaUtils.js'));

// Utility functions for delay calculation and execution (re-introduced for this worker process)
const getDelay = (messageCount, config) => {
  const { REST_DELAY_MIN, REST_DELAY_MAX, MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX, MESSAGE_LIMIT_BEFORE_DELAY } = config;
  return (messageCount % MESSAGE_LIMIT_BEFORE_DELAY === 0) // Use the new configurable limit
      ? Math.random() * (REST_DELAY_MAX - REST_DELAY_MIN) + REST_DELAY_MIN
      : Math.random() * (MESSAGE_DELAY_MAX - MESSAGE_DELAY_MIN) + MESSAGE_DELAY_MIN;
};

const delayExecution = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to send a message to a client (same as before)
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

        // Extract media path if not provided directly (can be optimized if `createMessageMedia` handles it)
        if (!mediaPath) {
            const extracted = extractMediaPath(message);
            mediaPath = extracted.mediaPath;
            message = extracted.cleanMessage;
        }

        clientProcess.send({ type: 'send_message', phoneNumber, message, mediaPath, userId, leadID });
    });
};

// Main function to process messages from Redis queue
const processRedisQueue = async (clientId, client) => {
    logClientEvent(clientId, 'info', 'Starting Redis queue consumer');
    const queueKey = `whatsapp:queue:${clientId}`;

    let messageCount = 0;

    while (true) { // Infinite loop to continuously process messages
        const config = getConfig(); // Load config for delays for each iteration
        try {
            // BLPOP blocks until an element is available or timeout (0 for indefinite block)
            const result = await redis.blpop(queueKey, 5); // Set a 5-second timeout

            if (result) {
                const [listName, messageDataString] = result;
                const messageData = JSON.parse(messageDataString);
                logClientEvent(clientId, 'info', `Processing message from Redis queue for ${messageData.phoneNumber}`);

                await client.sendMessage(messageData.phoneNumber, messageData.message, messageData.mediaPath ? { media: await createMessageMedia(messageData.mediaPath, messageData.message).then(res => res.media), caption: messageData.message } : {});

                logMessageStatus(messageData.userId, messageData.phoneNumber, 'sent', messageData.leadID);
                logClientEvent(clientId, 'info', `Message sent successfully to ${messageData.phoneNumber} from Redis queue`);

                messageCount++;
                const delay = getDelay(messageCount, config);
                await delayExecution(delay);
            }
        } catch (error) {
            logClientEvent(clientId, 'error', `Error processing Redis queue for ${clientId}: ${error.message}`);
            // Optionally, push message back to queue or to a dead-letter queue if recoverable error
            await delayExecution(5000); // Small delay before retrying queue read on error
        }
    }
};

// Main execution block
(async () => {
    const clientId = process.argv[2];
    logClientEvent(clientId, 'info', `Client process starting for clientId: ${clientId}`);

    try {
        // Connect to MongoDB with a timeout
        await mongoose.connect('mongodb://mongo:27017/whatsapp-sessions', {
            serverSelectionTimeoutMS: 5000 // 5-second timeout to select a server
        });
        logClientEvent(clientId, 'info', 'Successfully connected to MongoDB');

        const store = new MongoStore({ mongoose: mongoose });

        const client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                clientId: clientId,
                backupSyncIntervalMs: 60000 // A 1-minute backup sync interval
            }),
            puppeteer: {
                headless: true,
                defaultViewport: null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-sync',
                    '--disable-component-update',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-translate',
                    '--disable-features=ImprovedCookeiControls',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--enable-automation',
                    '--disable-notifications',
                    '--disable-extensions',
                ]
            }
        });

        // Enhanced event logging
        client.on('qr', (qr) => {
            logClientEvent(clientId, 'info', 'QR Code generated');
            qrcode.generate(qr, { small: true });
            if (process.send) {
                logClientEvent(clientId, 'debug', 'Sending QR event to parent process.');
                process.send({ type: 'qr', clientId, qr });
            }
        });

        client.on('ready', () => {
            logClientEvent(clientId, 'info', 'Client is ready and authenticated');
            if (process.send) {
                logClientEvent(clientId, 'debug', 'Sending READY event to parent process.');
                process.send({ type: 'ready', clientId });
            }
            // Start processing Redis queue when client is ready
            processRedisQueue(clientId, client).catch(error => {
                logClientEvent(clientId, 'error', `Failed to start Redis queue processing: ${error.message}`);
            });
        });
        
        client.on('remote_session_saved', () => {
            logClientEvent(clientId, 'info', 'Remote session has been saved to MongoDB.');
            if (process.send) {
                logClientEvent(clientId, 'debug', 'Sending REMOTE_SESSION_SAVED event to parent process.');
                process.send({ type: 'remote_session_saved', clientId });
            }
        });

        client.on('disconnected', (reason) => {
            logClientEvent(clientId, 'warn', `Client disconnected: ${reason}`);
            if (process.send) process.send({ type: 'disconnected', clientId });
        });

        client.on('auth_failure', (msg) => {
            logClientEvent(clientId, 'error', `Authentication failed: ${msg}`);
            if (process.send) process.send({ type: 'auth_failure', clientId, error: msg });
        });

        client.on('error', (error) => {
            logClientEvent(clientId, 'error', `Client error occurred: ${error.message}`);
            if (process.send) process.send({ type: 'error', clientId, error: error.message });
        });

        // Enhanced message handling
        process.on('message', async (msg) => {
            if (!msg || typeof msg.type !== 'string') {
                logClientEvent(clientId, 'error', 'Invalid message received');
                return;
            }

            if (msg.type === 'terminate') {
                logClientEvent(clientId, 'info', 'Termination requested');
                try {
                    await store.save(); // Explicitly save session before destroying
                    await client.destroy();
                    logClientEvent(clientId, 'info', 'Client destroyed successfully');
                    if (process.send) process.send({ type: 'terminated', clientId });
                    process.exit(0);
                } catch (error) {
                    logClientEvent(clientId, 'error', `Termination failed: ${error.message}`);
                    if (process.send) process.send({ type: 'terminate_error', clientId, error: error.message });
                    process.exit(1);
                }
            } else if (msg.type === 'send_immediate_message') {
                logClientEvent(clientId, 'info', `Received immediate message request for ${msg.phoneNumber}`);
                try {
                    const { phoneNumber, message, mediaPath } = msg;
                    if (mediaPath) {
                        const { media, caption } = await createMessageMedia(mediaPath, message);
                        await client.sendMessage(phoneNumber, media, { caption });
                    } else {
                        await client.sendMessage(phoneNumber, message);
                    }
                    if (process.send) process.send({ type: 'immediate_message_sent', leadID: msg.leadID });
                } catch (error) {
                    logClientEvent(clientId, 'error', `Failed to send immediate message: ${error.message}`);
                    if (process.send) process.send({ type: 'immediate_message_error', leadID: msg.leadID, error: error.message });
                }
            }
        });

        // Initialize client with error handling
        logClientEvent(clientId, 'debug', 'Calling client.initialize()...');
        await client.initialize();
        logClientEvent(clientId, 'debug', 'client.initialize() completed.');

    } catch (error) {
        logClientEvent(process.argv[2], 'error', `Client process failed to start: ${error.message}`);
        if (process.send) {
            process.send({ type: 'init_error', clientId: process.argv[2], error: error.message });
        }
        process.exit(1);
    }
})();