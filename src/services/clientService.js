const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { setClientState, deleteClientState } = require('./clientStateService');


const clients = {};

const initializeClient = (clientId) => {
    return new Promise((resolve, reject) => {
        if (clients[clientId]?.isActive) {
            logClientEvent(clientId, 'info', `Client ${clientId} is already active.`);
            return resolve();
        }

        // If client is already initializing, return the existing promise
        if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
            logClientEvent(clientId, 'info', `Client ${clientId} is already being initialized. Returning existing promise.`);
            return clients[clientId].initializationPromise;
        }

        if (clients[clientId]?.isInitializing) {
            return reject(new Error('Client is already being initialized'));
        }

        const clientProcess = fork(path.join(SERVICES_DIR, 'clientProcess.js'), [clientId]);

        // Persist initial state to Redis
        setClientState(clientId, { clientId, pid: clientProcess.pid, status: 'initializing' }).catch(err => {
            logClientEvent(clientId, 'error', `Failed to set initial state in Redis: ${err.message}`);
        });

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
                    setClientState(clientId, { status: 'ready' });
                    // Resolve the main initialization promise early if the client is ready and still initializing
                    if (clients[clientId]?.isInitializing) {
                        clients[clientId].isInitializing = false;
                        resolveInitializationPromise();
                    }
                    break;
                case 'remote_session_saved':
                    clients[clientId].isActive = true;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'info', 'Client session saved and is now fully active.');
                    setClientState(clientId, { status: 'active' });
                    resolveInitializationPromise(); // Resolve the main initialization promise here
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', 'Client is disconnected');
                    setClientState(clientId, { status: 'disconnected' });
                    break;
                case 'auth_failure':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Authentication failure: ${msg.error}`);
                    deleteClientState(clientId); // Clean up Redis state on failure
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
                    deleteClientState(clientId); // Clean up Redis state on failure
                    rejectInitializationPromise(new Error(`Initialization failed: ${msg.error}`));
                    // Also reject the QR promise if it hasn't been resolved yet
                    rejectQrPromise(new Error(`Initialization failed before QR for ${clientId}: ${msg.error}`));
                    break;
                case 'terminated':
                    clients[clientId].isActive = false;
                    clients[clientId].isDestroying = false;
                    delete clients[clientId];
                    deleteClientState(clientId); // Clean up Redis state
                    logClientEvent(clientId, 'info', 'Client terminated and cleaned up');
                    break;
                case 'qr':
                    // Resolve the main initialization promise early if QR is received and still initializing
                    if (clients[clientId]?.isInitializing) {
                        clients[clientId].isInitializing = false;
                        resolveInitializationPromise();
                    }
                    setClientState(clientId, { status: 'qr_ready' });
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
                deleteClientState(clientId); // Clean up Redis state
                logClientEvent(clientId, 'info', `Client process exited with code ${code}, signal ${signal}`);
                if (wasInitializing) {
                    rejectInitializationPromise(new Error(`Client process exited unexpectedly during initialization.`));
                }
            }
        });

        clientProcess.on('error', (error) => {
            if (clients[clientId]) {
                clients[clientId].isInitializing = false;
                logClientEvent(clientId, 'error', `Client process error: ${error.message}`);
                deleteClientState(clientId); // Clean up Redis state
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
        setClientState(clientId, { status: 'terminating' }); // Update state in Redis
        clientEntry.process.send({ type: 'terminate' });

        const terminationTimeout = setTimeout(() => {
            logClientEvent(clientId, 'error', 'Client termination timed out.');
            delete clients[clientId];
            deleteClientState(clientId); // Final cleanup
            reject(new Error(`Termination timed out for client ${clientId}`));
        }, 30000); // 30-second timeout

        clientEntry.process.once('message', (msg) => {
            if (msg.type === 'terminated') {
                clearTimeout(terminationTimeout);
                delete clients[clientId];
                deleteClientState(clientId); // Final cleanup
                logClientEvent(clientId, 'info', 'Client terminated and cleaned up successfully');
                resolve();
            }
        });

        // Handle case where process exits unexpectedly
        clientEntry.process.once('exit', () => {
            clearTimeout(terminationTimeout);
            delete clients[clientId];
            deleteClientState(clientId); // Final cleanup
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

