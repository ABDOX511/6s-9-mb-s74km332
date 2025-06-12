const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { DATA_AUTH, LOGGER_DIR, MEDIA_DIR } = require('../config/paths');
const { Client, LocalAuth } = require('whatsapp-web.js');


const { logClientEvent, logMessageStatus } = require(path.join(LOGGER_DIR, 'logUtils.js'));
const { createMessageMedia } = require(path.join(MEDIA_DIR, 'mediaUtils.js'));



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
  });

  client.on('disconnected', (reason) => {
      logClientEvent(clientId, 'warn', `Client disconnected: ${reason}`);
      onsole.log(`Client ${clientId} is disconnected.`);
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

          case 'send_message':
              const { phoneNumber, message, mediaPath, userId, leadID } = msg;
              logClientEvent(clientId, 'info', `Message send requested to ${phoneNumber}`);

              if (!phoneNumber || !userId) {
                  logClientEvent(clientId, 'error', `Invalid message parameters for ${phoneNumber}`);
                  logMessageStatus(userId, phoneNumber, 'failed', leadID, 'Missing phoneNumber or userId');
                  process.send({ type: 'message_error', clientId, phoneNumber, error: 'Missing phoneNumber or userId' });
                  return;
              }

              try {
                  let sentMessage;
                  if (mediaPath) {
                      logClientEvent(clientId, 'debug', `Creating media message from ${mediaPath}`);
                      const { media, caption } = await createMessageMedia(mediaPath, message);
                      if (!media) {
                          throw new Error('Media creation failed');
                      }
                      sentMessage = await client.sendMessage(phoneNumber, media, { caption });
                      logClientEvent(clientId, 'debug', 'Media message sent successfully');
                  } else {
                      sentMessage = await client.sendMessage(phoneNumber, message);
                      logClientEvent(clientId, 'debug', 'Text message sent successfully');
                  }
                  
                  logMessageStatus(userId, phoneNumber, 'sent', leadID);
                  logClientEvent(clientId, 'info', `Message sent successfully to ${phoneNumber}`);
                  process.send({ type: 'message_sent', clientId, phoneNumber });
              } catch (error) {
                  logClientEvent(clientId, 'error', `Failed to send message to ${phoneNumber}: ${error.message}`);
                  logMessageStatus(userId, phoneNumber, 'failed', leadID, error.message);
                  process.send({ type: 'message_error', clientId, phoneNumber, error: error.message });
              }
              break;

          default:
              logClientEvent(clientId, 'warn', `Unknown message type received: ${msg.type}`);
      }
  });

  // Log uncaught exceptions
  process.on('uncaughtException', (error) => {
      logClientEvent(clientId, 'error', `Uncaught exception: ${error.message}`);
  });

  // Log unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
      logClientEvent(clientId, 'error', `Unhandled rejection: ${reason?.message || reason}`);
  });

  // Initialize client with error handling
  client.initialize().catch(error => {
      logClientEvent(clientId, 'error', `Client initialization failed: ${error.message}`);
      process.send({ type: 'init_error', clientId, error: error.message });
  });