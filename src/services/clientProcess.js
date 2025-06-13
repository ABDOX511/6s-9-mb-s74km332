const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { DATA_AUTH, UTILS_DIR, CONFIG_DIR } = require('../config/paths');
const { Client, LocalAuth } = require('whatsapp-web.js');
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
const processRedisQueue = async (clientId) => {
    logClientEvent(clientId, 'info', 'Starting Redis queue consumer');
    const queueKey = `whatsapp:queue:${clientId}`;

    let messageCount = 0;

    while (true) { // Infinite loop to continuously process messages
        const config = getConfig(); // Load config for delays for each iteration
        try {
            // BLPOP blocks until an element is available or timeout (0 for indefinite block)
            const [listName, messageDataString] = await redis.blpop(queueKey, 5); // Set a 5-second timeout

            if (messageDataString) {
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

  // Log startup
  logClientEvent(process.argv[2], 'info', 'Client process starting');

  const clientId = process.argv[2];

  const client = new Client({
      authStrategy: new LocalAuth({ clientId: `client-${clientId}`, 
      dataPath: DATA_AUTH
      }),
      puppeteer: {
          executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",  // Explicitly use Google Chrome
          headless: true,
          defaultViewport: null,
          args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--start-maximized',
              '--disable-gpu',
              '--display=:1',  // Using display :1 since we set up VNC on this display
              '--disable-notifications',
              '--disable-extensions',
              '--disable-default-apps',
              '--enable-features=NetworkService',
              '--allow-running-insecure-content',
              '--ignore-certificate-errors'
          ]
      }
  });

  // Enhanced event logging
  client.on('qr', (qr) => {
      logClientEvent(clientId, 'info', 'QR Code generated');
      qrcode.generate(qr, { small: true });
      console.log(`QR code generated for client ${clientId}, scan it with your phone.`);
      if (process.send) {
          process.send({ type: 'qr', clientId, qr });
          logClientEvent(clientId, 'debug', 'QR Code sent to parent process');
      }
  });

  client.on('ready', () => {
      logClientEvent(clientId, 'info', 'Client is ready and authenticated');
      console.log(`Client ${clientId} is ready!`);
      process.send({ type: 'ready', clientId });
      // Start processing Redis queue when client is ready
      processRedisQueue(clientId).catch(error => {
          logClientEvent(clientId, 'error', `Failed to start Redis queue processing: ${error.message}`);
      });
  });

  client.on('disconnected', (reason) => {
      logClientEvent(clientId, 'warn', `Client disconnected: ${reason}`);
      console.log(`Client ${clientId} is disconnected.`);
      process.send({ type: 'disconnected', clientId });
  });

  client.on('auth_failure', (msg) => {
      logClientEvent(clientId, 'error', `Authentication failed: ${msg}`);
      console.error(`Authentication failure for client ${clientId}:`, msg);
      process.send({ type: 'auth_failure', clientId, error: msg });
  });

  client.on('error', (error) => {
      logClientEvent(clientId, 'error', `Client error occurred: ${error.message}`);
      process.send({ type: 'error', clientId, error: error.message });
  });

  // Enhanced message handling
  process.on('message', async (msg) => {
      if (!msg || typeof msg.type !== 'string') {
          logClientEvent(clientId, 'error', 'Invalid message received');
          return;
      }

      logClientEvent(clientId, 'debug', `Received message from parent: ${msg.type}`);

      switch (msg.type) {
          case 'terminate':
              logClientEvent(clientId, 'info', 'Termination requested');
              try {
                  await client.destroy();
                  logClientEvent(clientId, 'info', 'Client destroyed successfully');
                  process.send({ type: 'terminated', clientId });
                  process.exit(0);
              } catch (error) {
                  logClientEvent(clientId, 'error', `Termination failed: ${error.message}`);
                  process.send({ type: 'terminate_error', clientId, error: error.message });
              }
              break;

          // The 'send_message' case is removed as messages are now consumed from Redis
          default:
              logClientEvent(clientId, 'warn', `Unknown message type received: ${msg.type}`);
      }
  });

  // Initialize client with error handling
  client.initialize().catch(error => {
      logClientEvent(clientId, 'error', `Client initialization failed: ${error.message}`);
      process.send({ type: 'init_error', clientId, error: error.message });
  });