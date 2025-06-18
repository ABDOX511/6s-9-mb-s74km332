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

            // Case 3: Client exists in memory but is in a problematic or stale state.
            // This is when we trigger `cleanupClient` with a full wipe if necessary.
            logClientEvent(clientId, 'warn', `Client ${clientId} found in an invalid state (disconnected, auth_failure, init_error, or stale). Attempting pre-initialization cleanup.`);

            // Add a robust check for the process's actual existence before trying to signal it.
            let processIsRunning = false;
            if (existingClientEntry.process && existingClientEntry.process.pid) {
                try {
                    process.kill(existingClientEntry.process.pid, 0); // Check if process exists (throws if not)
                    processIsRunning = true;
                } catch (e) {
                    if (e.code !== 'ESRCH') { // ESRCH means process doesn't exist, which is fine
                        logClientEvent(clientId, 'error', `Error checking process ${existingClientEntry.process.pid} for client ${clientId}: ${e.message}`);
                    }
                }
            }

            // Determine if a full cleanup is required based on process status and persisted state
            const clientStateFromRedis = await getClientState(clientId);
            const status = clientStateFromRedis.status;

            const shouldPerformFullCleanup = (
                processIsRunning ||
                status === 'auth_failure' ||
                status === 'init_error'
            );

            if (shouldPerformFullCleanup) {
                // Perform full cleanup if the process is running unexpectedly or if it's an authentication/initialization failure
                logClientEvent(clientId, 'info', `Client ${clientId} requires full cleanup based on process status or problematic state ('${status}').`);
                await cleanupClient(clientId, { fullCleanup: true });
            } else if (status === 'disconnected') {
                // If disconnected, but not an auth_failure/init_error, don't wipe session data, just update in-memory state
                logClientEvent(clientId, 'info', `Client ${clientId} is disconnected but session data is presumed valid. Updating in-memory state.`);
                delete clients[clientId]; // Remove from in-memory to allow fresh init without full data wipe
            } else {
                 // For any other unexpected stale state where no process is running and not critical status, perform full data cleanup as a precaution.
                 logClientEvent(clientId, 'info', `Stale in-memory entry for ${clientId} detected (process not running, status not critical). Performing full data cleanup as a precaution.`);
                 await cleanupClient(clientId, { fullCleanup: true });
            }
            // After potential cleanup, `clients[clientId]` should be undefined now, allowing a fresh start.
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
                    resolveInitializationPromise();
                    clearQrTimeout(clientId); // Clear timeout on ready
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', `Client disconnected: ${msg.reason || 'No reason provided'}`);
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
                    if (msg.error.includes('Execution context was destroyed')) {
                        logClientEvent(clientId, 'error', `Critical browser error detected. Triggering full client cleanup for ${clientId}.`);
                        cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                            logClientEvent(clientId, 'error', `Error during post-critical-error cleanup: ${err.message}`);
                        });
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
            logClientEvent(clientId, 'warn', `Client process ${clientId} exited unexpectedly with code ${code}, signal ${signal}. Triggering full cleanup.`);
            // An unexpected exit is considered a problematic state requiring a full cleanup.
            await cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                logClientEvent(clientId, 'error', `Error during exit cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && clients[clientId]?.initializationPromise) {
                clients[clientId].initializationPromise.reject(new Error(`Client process exited unexpectedly during initialization.`));
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
const terminateClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        const clientEntry = clients[clientId];
        if (!clientEntry) {
            logClientEvent(clientId, 'warn', `Attempted to terminate non-existent or non-running client ${clientId}. Ensuring state is 'disconnected'.`);
            // If not in memory, just ensure the persisted state reflects disconnection.
            await setClientState(clientId, { status: 'disconnected' }).catch(err => {});
            return resolve();
        }

        if (clientEntry.isDestroying) {
            logClientEvent(clientId, 'info', `Client ${clientId} is already being gracefully terminated.`);
            return resolve();
        }

        clientEntry.isDestroying = true;
        logClientEvent(clientId, 'info', `Initiating graceful shutdown for client ${clientId}...`);
        
        // Use the new cleanup function with fullCleanup set to false.
        await cleanupClient(clientId, { fullCleanup: false });
        
        logClientEvent(clientId, 'info', `Graceful shutdown complete for client ${clientId}.`);
        resolve();
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
        limit(() => terminateClient(clientId))
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

module.exports = {
    initializeClient,
    getClient,
    getAllClients,
    terminateClient,
    terminateAllClientsService,
    sendImmediateMessage
};

