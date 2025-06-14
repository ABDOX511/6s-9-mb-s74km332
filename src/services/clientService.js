const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));


const clients = {};

const initializeClient = (clientId) => {
    return new Promise((resolve, reject) => {
        if (clients[clientId]?.isActive) {
            console.log(`Client ${clientId} is already active.`);
            return resolve();
        }

        // If client is already initializing, return the existing promise
        if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
            console.log(`Client ${clientId} is already being initialized. Returning existing promise.`);
            return clients[clientId].initializationPromise;
        }

        // Timeout for the promise, but DON'T kill the process.
        // This allows the user to take their time scanning the QR code without the backend crashing.
        const promiseTimeout = setTimeout(() => {
            // Only log a warning if it's still initializing. Do NOT reject the promise here.
            // The promise should have been resolved by 'qr' or 'ready' events if successful.
            if (clients[clientId]?.isInitializing) {
                 logClientEvent(clientId, 'warn', `Initialization promise timed out for client ${clientId}. The process is still running in the background, but the promise was not resolved by 'qr' or 'ready' events in time.`);
            }
        }, 90000); // 90-second timeout for the promise.

        if (clients[clientId]?.isInitializing) {
            console.log(`Client ${clientId} is already being initialized.`);
            clearTimeout(promiseTimeout);
            return reject(new Error('Client is already being initialized'));
        }

        const clientProcess = fork(path.join(SERVICES_DIR, 'clientProcess.js'), [clientId]);

        let resolveQrPromise; // For the QR code specifically
        let rejectQrPromise;
        const qrPromise = new Promise((resolve, reject) => {
            resolveQrPromise = resolve;
            rejectQrPromise = reject;
        });

        // Capture the resolve/reject for the main initialization promise
        let resolveInitializationPromise;
        let rejectInitializationPromise;
        const initializationPromise = new Promise((resolve, reject) => {
            resolveInitializationPromise = resolve;
            rejectInitializationPromise = reject;
        });

        clients[clientId] = {
            process: clientProcess,
            isActive: false,
            isDestroying: false,
            isInitializing: true,
            isReady: false, // Explicitly track ready state
            qrPromise: qrPromise, // Expose QR promise
            initializationPromise: initializationPromise, // Store the main initialization promise
        };

        clientProcess.on('message', (msg) => {
            if (!msg || typeof msg.type !== 'string') return;

            switch (msg.type) {
                case 'ready':
                    clients[clientId].isReady = true;
                    logClientEvent(clientId, 'info', 'Client is ready, awaiting session save.');
                    // Resolve the main initialization promise early if the client is ready and still initializing
                    if (clients[clientId]?.isInitializing) {
                        clearTimeout(promiseTimeout);
                        clients[clientId].isInitializing = false;
                        resolveInitializationPromise();
                    }
                    break;
                case 'remote_session_saved':
                    clients[clientId].isActive = true;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'info', 'Client session saved and is now fully active.');
                    clearTimeout(promiseTimeout);
                    resolveInitializationPromise(); // Resolve the main initialization promise here
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', 'Client is disconnected');
                    break;
                case 'auth_failure':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Authentication failure: ${msg.error}`);
                    clearTimeout(promiseTimeout);
                    rejectInitializationPromise(new Error(`Authentication failure: ${msg.error}`));
                    // Also reject the QR promise if it hasn't been resolved yet
                    rejectQrPromise(new Error(`Authentication failed before QR for ${clientId}: ${msg.error}`));
                    break;
                case 'error':
                     // General errors might not stop the initialization promise, but we should log them
                    logClientEvent(clientId, 'error', `Error: ${msg.error}`);
                    break;
                case 'init_error': // Specific error for initialization failures
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Initialization Error: ${msg.error}`);
                    clearTimeout(promiseTimeout);
                    rejectInitializationPromise(new Error(`Initialization failed: ${msg.error}`));
                    // Also reject the QR promise if it hasn't been resolved yet
                    rejectQrPromise(new Error(`Initialization failed before QR for ${clientId}: ${msg.error}`));
                    break;
                case 'terminated':
                    clients[clientId].isActive = false;
                    clients[clientId].isDestroying = false;
                    delete clients[clientId];
                    logClientEvent(clientId, 'info', 'Client terminated and cleaned up');
                    break;
                case 'qr':
                    // Resolve the main initialization promise early if QR is received and still initializing
                    if (clients[clientId]?.isInitializing) {
                        clearTimeout(promiseTimeout);
                        clients[clientId].isInitializing = false;
                        resolveInitializationPromise();
                    }
                    resolveQrPromise(msg.qr);
                    break;
                case 'message_sent':
                    break;
                default:
                    logClientEvent(clientId, 'warn', `Unknown message type: ${msg.type}`);
            }
        });

        clientProcess.on('exit', (code, signal) => {
            if (clients[clientId]) {
                const wasInitializing = clients[clientId].isInitializing;
                delete clients[clientId];
                logClientEvent(clientId, 'info', `Client process exited with code ${code}, signal ${signal}`);
                if (wasInitializing) {
                    clearTimeout(promiseTimeout);
                    rejectInitializationPromise(new Error(`Client process exited unexpectedly during initialization.`));
                }
            }
        });

        clientProcess.on('error', (error) => {
            if (clients[clientId]) {
                clients[clientId].isInitializing = false;
                logClientEvent(clientId, 'error', `Client process error: ${error.message}`);
                clearTimeout(promiseTimeout);
                rejectInitializationPromise(error);
            }
        });
    });
};

const terminateClient = (clientId) => {
    return new Promise((resolve, reject) => {
        const clientEntry = clients[clientId];

        if (!clientEntry) {
            logClientEvent(clientId, 'warn', 'Attempted to terminate a non-existent client.');
            return resolve(); // Resolve peacefully if client doesn't exist
        }

        if (clientEntry.isDestroying) {
            logClientEvent(clientId, 'info', 'Client termination already in progress.');
            // You might want to wait for the existing termination promise here
            // For now, we resolve to avoid hanging
            return resolve();
        }

        clientEntry.isDestroying = true;
        logClientEvent(clientId, 'info', `Sending terminate signal to client ${clientId}`);
        clientEntry.process.send({ type: 'terminate' });

        const terminationTimeout = setTimeout(() => {
            logClientEvent(clientId, 'error', 'Client termination timed out.');
            delete clients[clientId];
            reject(new Error(`Termination timed out for client ${clientId}`));
        }, 30000); // 30-second timeout

        clientEntry.process.once('message', (msg) => {
            if (msg.type === 'terminated') {
                clearTimeout(terminationTimeout);
                delete clients[clientId];
                logClientEvent(clientId, 'info', 'Client terminated and cleaned up successfully');
                resolve();
            }
        });

        // Handle case where process exits unexpectedly
        clientEntry.process.once('exit', () => {
            clearTimeout(terminationTimeout);
            delete clients[clientId];
            logClientEvent(clientId, 'warn', `Client process for ${clientId} exited unexpectedly during termination.`);
            resolve(); // Resolve to not block the shutdown process
        });
    });
};

const terminateAllClientsService = async () => {
    const allClients = getAllClients();
    if (Object.keys(allClients).length === 0) return;

    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(5);
    const terminationPromises = Object.keys(allClients).map(id => 
        limit(() => terminateClient(id))
    );

    await Promise.all(terminationPromises);
};

const sendImmediateMessage = (clientId, messageData) => {
    return new Promise((resolve, reject) => {
        const clientEntry = clients[clientId];
        if (!clientEntry || !clientEntry.process) {
            return reject(new Error(`Client process not found for clientId: ${clientId}`));
        }

        const messageTimeout = setTimeout(() => {
            reject(new Error('Immediate message send timed out.'));
        }, 30000); // 30-second timeout

        const onMessageResponse = (msg) => {
            if (msg.type === 'immediate_message_sent' && msg.leadID === messageData.leadID) {
                cleanup();
                resolve();
            } else if (msg.type === 'immediate_message_error' && msg.leadID === messageData.leadID) {
                cleanup();
                reject(new Error(msg.error));
            }
        };

        const cleanup = () => {
            clearTimeout(messageTimeout);
            clientEntry.process.off('message', onMessageResponse);
        };

        clientEntry.process.on('message', onMessageResponse);
        clientEntry.process.send({ type: 'send_immediate_message', ...messageData });
    });
};

const getClient = (clientId) => clients[clientId];
const getAllClients = () => clients;

module.exports = {
    initializeClient,
    getClient,
    getAllClients,
    terminateClient,
    terminateAllClientsService,
    sendImmediateMessage
};

