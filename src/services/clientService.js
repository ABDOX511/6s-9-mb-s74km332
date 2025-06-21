const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { setClientState, deleteClientState, getClientState } = require('./clientStateService');

const fs = require('fs-extra');
const { DATA_AUTH } = require('../config/paths');

const clients = {};
const cleanupLocks = new Map(); // Add this line for the mutex

const QR_TIMEOUT_MS = 120000; // 2 minutes (120,000 milliseconds) for QR scan/authentication

/**
 * The primary client cleanup function. It terminates the client process and then,
 * based on the `fullCleanup` flag, either wipes all associated data (Redis, Mongo, local files)
 * or performs a graceful shutdown by simply updating the state to 'disconnected'.
 *
 * @param {string} clientId The ID of the client to clean up.
 * @param {object} [options]
 * @param {boolean} [options.fullCleanup=true] If true, performs a full data wipe. If false, performs a graceful shutdown.
 * @returns {Promise<void>}
 */
const cleanupClient = async (clientId, { fullCleanup = true } = {}) => {
    // Mutex to prevent multiple concurrent cleanup operations for the same client
    if (cleanupLocks.has(clientId)) {
        logClientEvent(clientId, 'debug', `Cleanup for ${clientId} already in progress. Awaiting existing operation.`);
        return cleanupLocks.get(clientId);
    }

    const lock = (async () => {
        const existingClientEntry = clients[clientId];
        if (existingClientEntry) {
            logClientEvent(clientId, 'warn', `Cleanup process initiated for client ${clientId}. Full cleanup: ${fullCleanup}.`);

            // Stop the process if it exists
            if (existingClientEntry.process) {
                try {
                    // Send terminate signal to the child process
                    existingClientEntry.process.send({ type: 'terminate' });

                    // Wait for the process to exit or timeout
                    await new Promise((resolve) => {
                        const timeout = setTimeout(() => {
                            logClientEvent(clientId, 'error', `Client process termination for ${clientId} timed out. Forcibly killing process.`);
                            existingClientEntry.process.kill('SIGKILL');
                            resolve();
                        }, 10000);

                        existingClientEntry.process.removeAllListeners('exit');
                        existingClientEntry.process.removeAllListeners('error');
                        existingClientEntry.process.removeAllListeners('message');

                        existingClientEntry.process.once('exit', (code, signal) => {
                            clearTimeout(timeout);
                            logClientEvent(clientId, 'info', `Client process ${clientId} exited with code ${code}, signal ${signal}.`);
                            resolve();
                        });

                        existingClientEntry.process.once('error', (error) => {
                            clearTimeout(timeout);
                            logClientEvent(clientId, 'error', `Error during client process termination for ${clientId}: ${error.message}`);
                            resolve();
                        });
                    });
                } catch (err) {
                    logClientEvent(clientId, 'error', `Error sending terminate signal to client ${clientId}: ${err.message}`);
                }
            }
        }

        // Always remove from in-memory cache
        delete clients[clientId];

        if (fullCleanup) {
            logClientEvent(clientId, 'info', `Performing FULL data wipe for client ${clientId}.`);
            await deleteClientState(clientId).catch(err => {
                logClientEvent(clientId, 'error', `Failed to delete Redis state for ${clientId} during full cleanup: ${err.message}`);
            });
            const clientAuthDir = path.join(DATA_AUTH, `session-${clientId}`); // Note: Path adjusted to match common practice
            if (await fs.pathExists(clientAuthDir)) {
                try {
                    await fs.remove(clientAuthDir);
                    logClientEvent(clientId, 'info', `Removed local browser data directory for ${clientId} during full cleanup.`);
                } catch (err) {
                    logClientEvent(clientId, 'error', `Failed to remove local browser data for ${clientId} during full cleanup: ${err.message}`);
                }
            }
            logClientEvent(clientId, 'info', `Completed full state cleanup for client ${clientId}.`);

        } else {
            logClientEvent(clientId, 'info', `Performing GRACEFUL shutdown for client ${clientId}. Preserving session data.`);
            await setClientState(clientId, { status: 'disconnected' }).catch(err => {
                logClientEvent(clientId, 'error', `Failed to set Redis status to 'disconnected' for ${clientId}: ${err.message}`);
            });
        }
    })();
    cleanupLocks.set(clientId, lock);
    return lock;
};

const initializeClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        const existingClientEntry = clients[clientId];

        if (existingClientEntry) {
            // Case 1: Client is already active or ready. Do NOT clean up, just return existing.
            if (existingClientEntry.isActive || existingClientEntry.isReady) {
                logClientEvent(clientId, 'info', `Client ${clientId} is already active/ready. No action needed.`);
                return resolve();
            }

            // Case 2: Client is currently initializing. Return existing promise to avoid duplicate initialization.
            if (existingClientEntry.isInitializing && existingClientEntry.initializationPromise) {
                logClientEvent(clientId, 'info', `Client ${clientId} is already being initialized. Returning existing promise.`);
                return existingClientEntry.initializationPromise;
            }

            // Case 3: Client exists in memory but is in a problematic or stale state (not active/ready, not initializing).
            // Check if we have a saved session before doing full cleanup
            const clientAuthDir = path.join(DATA_AUTH, `session-${clientId}`);
            const hasExistingSession = await fs.pathExists(clientAuthDir);
            
            if (hasExistingSession) {
                logClientEvent(clientId, 'info', `Client ${clientId} found in stale state but has existing session. Performing graceful cleanup.`);
                // Graceful cleanup to preserve session
                await cleanupClient(clientId, { fullCleanup: false }).catch(err => {
                    logClientEvent(clientId, 'error', `Error during graceful cleanup for ${clientId}: ${err.message}`);
                });
            } else {
                logClientEvent(clientId, 'warn', `Client ${clientId} found in invalid state with no session. Performing full cleanup.`);
                // Full cleanup if no session exists
                await cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                    logClientEvent(clientId, 'error', `Error during pre-initialization full cleanup for ${clientId}: ${err.message}`);
                });
            }

            // Attempt to kill the process if it exists and is running unexpectedly
            if (existingClientEntry.process && existingClientEntry.process.pid) {
                try {
                    process.kill(existingClientEntry.process.pid, 0); // Check if process exists (throws if not)
                    logClientEvent(clientId, 'info', `Found and about to terminate stale process ${existingClientEntry.process.pid} for client ${clientId}.`);
                    // Force kill to ensure no lingering process prevents new one
                    existingClientEntry.process.kill('SIGKILL');
                } catch (e) {
                    if (e.code !== 'ESRCH') { // ESRCH means process doesn't exist, which is fine
                        logClientEvent(clientId, 'error', `Error checking or killing stale process ${existingClientEntry.process.pid} for client ${clientId}: ${e.message}`);
                    }
                }
            }
        }

        // No existing client or existing one was cleaned up, proceed to fork a new process
        const clientProcess = fork(path.join(SERVICES_DIR, 'clientProcess.js'), [clientId], {
            execArgv: ['--unhandled-rejections=strict'] // Add this for process-level hardening
        });

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
            qrTimeout: null, // Initialize qrTimeout to null
        };

        // --- Start QR Timeout ---
        clients[clientId].qrTimeout = setTimeout(async () => {
            const currentClientEntry = clients[clientId];
            // Only terminate if the client is still in an initializing or qr_ready state
            if (currentClientEntry && !currentClientEntry.isActive && !currentClientEntry.isReady) {
                logClientEvent(clientId, 'warn', `Client ${clientId} QR/Authentication timeout reached. Terminating due to no QR scan or successful authentication.`);
                await cleanupClient(clientId, { fullCleanup: true }); // Perform full cleanup
                if (rejectInitializationPromise) {
                    rejectInitializationPromise(new Error('QR scan/Authentication timed out.'));
                }
            } else {
                logClientEvent(clientId, 'debug', `QR timeout for ${clientId} triggered, but client is already active/ready or terminated. No action needed.`);
            }
        }, QR_TIMEOUT_MS);
        logClientEvent(clientId, 'debug', `QR timeout set for ${clientId} (${QR_TIMEOUT_MS / 1000}s).`);
        // --- End QR Timeout ---

        // Helper to clear the QR timeout
        const clearQrTimeout = (id) => {
            if (clients[id] && clients[id].qrTimeout) {
                clearTimeout(clients[id].qrTimeout);
                clients[id].qrTimeout = null;
                logClientEvent(id, 'debug', 'QR timeout cleared.');
            }
        };

        clientProcess.on('message', async (msg) => {
            // Defensive check: Ensure clients[clientId] still exists before accessing
            if (!clients[clientId]) {
                logClientEvent(clientId, 'warn', `Received message for ${clientId} but client entry is missing. Message type: ${msg.type}. Skipping message processing.`);
                return; // Ignore message if client entry is gone
            }

            if (!msg || typeof msg.type !== 'string') {
                logClientEvent(clientId, 'warn', `Invalid message format received for ${clientId}. Message: ${JSON.stringify(msg)}. Skipping message processing.`);
                return;
            }

            switch (msg.type) {
                case 'ready':
                    clients[clientId].isReady = true;
                    clients[clientId].isActive = true; // With LocalAuth, consider the client fully active once ready
                    logClientEvent(clientId, 'info', 'Client is ready, session data saved locally.');
                    setClientState(clientId, { status: 'active' });
                    
                    // Add a small delay to ensure the client is truly ready for messaging
                    setTimeout(() => {
                        resolveInitializationPromise();
                    }, 1000);
                    
                    clearQrTimeout(clientId); // Clear timeout on ready
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', `Client disconnected: ${msg.reason || 'No reason provided'}`);
                    // Update Redis state to disconnected on remote disconnect
                    await setClientState(clientId, { status: 'disconnected' }).catch(err => {
                        logClientEvent(clientId, 'error', `Failed to set Redis status to 'disconnected' on client disconnect: ${err.message}`);
                    });
                    // A remote disconnect is a problematic state that requires a full cleanup to ensure a clean restart.
                    cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                         logClientEvent(clientId, 'error', `Error during post-disconnect cleanup: ${err.message}`);
                    });
                    clearQrTimeout(clientId); // Clear timeout on disconnect
                    break;
                case 'auth_failure':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Authentication failed: ${msg.error}`);
                    // This is a problematic state, trigger full cleanup
                    rejectInitializationPromise(new Error(`Authentication failure: ${msg.error}`));
                    rejectQrPromise(new Error(`Authentication failed before QR for ${clientId}: ${msg.error}`));
                    cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-auth_failure cleanup: ${err.message}`);
                    });
                    clearQrTimeout(clientId); // Clear timeout on auth failure
                    break;
                case 'error':
                    logClientEvent(clientId, 'error', `Client process error: ${msg.error}`);
                    // Any client error indicates a problematic state, trigger full cleanup.
                    cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                        logClientEvent(clientId, 'error', `Error during cleanup after client process error: ${err.message}`);
                    });
                    // If the initialization promise was still pending, reject it.
                    if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
                        clients[clientId].initializationPromise.reject(new Error(`Client process error during initialization: ${msg.error}`));
                    }
                    clearQrTimeout(clientId); // Clear timeout on any process error
                    break;
                case 'init_error':
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Initialization Error: ${msg.error}`);
                    // This is a problematic state, trigger full cleanup
                    rejectInitializationPromise(new Error(`Initialization failed: ${msg.error}`));
                    rejectQrPromise(new Error(`Initialization failed before QR for ${clientId}: ${msg.error}`));
                    cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-init_error cleanup: ${err.message}`);
                    });
                    clearQrTimeout(clientId); // Clear timeout on init error
                    break;
                case 'terminated':
                    logClientEvent(clientId, 'info', `Received 'terminated' signal from client process ${clientId}.`);
                    clearQrTimeout(clientId); // Clear timeout on graceful termination
                    break;
                case 'qr':
                    if (clients[clientId]?.isInitializing) {
                        clients[clientId].isInitializing = false;
                        resolveInitializationPromise();
                    }
                    setClientState(clientId, { status: 'qr_ready' });
                    resolveQrPromise(msg.qr);
                    // Do NOT clear timeout here. This means QR is shown, still waiting for scan.
                    break;
                case 'message_sent':
                    break;
                default:
                    logClientEvent(clientId, 'warn', `Unknown message type received: ${msg.type}`);
            }
        });

        // Ensure cleanup on unexpected exit/error of child process
        clientProcess.on('exit', async (code, signal) => {
            // Code 130 is normal when server is stopped with Ctrl+C (SIGINT)
            const isNormalExit = code === 0 || (code === 130 && signal === null);
            const logLevel = isNormalExit ? 'info' : 'warn';
            const message = isNormalExit 
                ? `Client process ${clientId} exited normally with code ${code}, signal ${signal}.`
                : `Client process ${clientId} exited unexpectedly with code ${code}, signal ${signal}. Triggering full cleanup.`;
            
            logClientEvent(clientId, logLevel, message);
            
            // An unexpected exit is considered a problematic state requiring a full cleanup.
            await cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                logClientEvent(clientId, 'error', `Error during exit cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
                clients[clientId].initializationPromise.reject(new Error(`Client process exited during initialization.`));
            }
            clearQrTimeout(clientId); // Clear timeout on process exit
        });

        clientProcess.on('error', async (error) => {
            logClientEvent(clientId, 'error', `Client process ${clientId} encountered an error: ${error.message}. Triggering full cleanup.`);
            // A process-level error is critical and requires a full cleanup.
            await cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                logClientEvent(clientId, 'error', `Error during error cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
                clients[clientId].initializationPromise.reject(new Error(`Client process error during initialization: ${error.message}`));
            }
            clearQrTimeout(clientId); // Clear timeout on process error
        });
    });
};

/**
 * Initiates a GRACEFUL shutdown of a client.
 * This function is called for standard termination requests (e.g., from an API endpoint).
 * It stops the client process but preserves all session data on disk and in Redis.
 *
 * @param {string} clientId The ID of the client to terminate.
 * @returns {Promise<void>}
 */
const terminateClient = async (clientId, options = {}) => {
    await cleanupClient(clientId, options).catch(err => {
        logClientEvent(clientId, 'error', `Error in terminateClient (controller called): ${err.message}`);
    });
};

const getClient = (clientId) => {
    return clients[clientId];
};

const getAllClients = () => {
    return clients; // Returns the in-memory clients object
};

const terminateAllClientsService = async () => {
    const allClientIds = Object.keys(clients);
    if (allClientIds.length === 0) {
        logClientEvent('all', 'info', 'No active clients to terminate.');
        return;
    }

    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(5); // Concurrently terminate up to 5 clients

    const terminationPromises = allClientIds.map(clientId =>
        limit(() => terminateClient(clientId, { fullCleanup: false }))
    );

    await Promise.all(terminationPromises);
    logClientEvent('all', 'info', 'All clients termination process initiated.');
};

const sendImmediateMessage = (clientId, messageData) => {
    return new Promise((resolve, reject) => {
        const clientEntry = clients[clientId];
        if (!clientEntry || !clientEntry.process) {
            return reject(new Error(`Client process not found for clientId: ${clientId}`));
        }

        logClientEvent(clientId, 'debug', `Sending immediate message with leadID: ${messageData.leadID}`);

        const messageTimeout = setTimeout(() => {
            cleanup();
            reject(new Error('Immediate message send timed out.'));
        }, 30000); // 30-second timeout

        const onMessageResponse = (msg) => {
            logClientEvent(clientId, 'debug', `Received response: ${msg.type}, leadID: ${msg.leadID}, expected: ${messageData.leadID}`);
            if (msg.type === 'immediate_message_sent' && String(msg.leadID) === String(messageData.leadID)) {
                cleanup();
                resolve();
            } else if (msg.type === 'immediate_message_error' && String(msg.leadID) === String(messageData.leadID)) {
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

module.exports = {
    initializeClient,
    getClient,
    getAllClients,
    terminateClient,
    terminateAllClientsService,
    sendImmediateMessage
};


