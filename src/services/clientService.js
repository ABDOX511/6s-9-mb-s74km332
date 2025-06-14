const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { setClientState, deleteClientState, getClientState, deleteClientSessionFromMongo } = require('./clientStateService');

const fs = require('fs-extra');
const { DATA_AUTH } = require('../config/paths');

const clients = {};

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
        await deleteClientSessionFromMongo(clientId).catch(err => {
            logClientEvent(clientId, 'error', `Failed to delete MongoDB session for ${clientId} during full cleanup: ${err.message}`);
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
            // This is when we trigger `cleanupClient` with a full wipe.
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

            if (processIsRunning || existingClientEntry.status === 'disconnected' || existingClientEntry.status === 'auth_failure' || existingClientEntry.status === 'init_error') {
                 // Call full cleanup if process is running or state is explicitly problematic
                 await cleanupClient(clientId, { fullCleanup: true });
            } else {
                 // If in-memory entry exists but process is NOT running and state is not explicitly problematic,
                 // it's likely a leftover from an abrupt shutdown. Perform a lighter cleanup of just the data.
                 logClientEvent(clientId, 'info', `Stale in-memory entry for ${clientId} detected (process not running, status not critical). Performing full data cleanup as a precaution.`);
                 delete clients[clientId];
                 await deleteClientState(clientId).catch(err => { logClientEvent(clientId, 'error', `Stale Redis cleanup failed: ${err.message}`); });
                 await deleteClientSessionFromMongo(clientId).catch(err => { logClientEvent(clientId, 'error', `Stale Mongo cleanup failed: ${err.message}`); });
                 const clientAuthDir = path.join(DATA_AUTH, clientId);
                 if (await fs.pathExists(clientAuthDir)) {
                     try { await fs.remove(clientAuthDir); logClientEvent(clientId, 'info', `Removed local browser data directory for ${clientId} during stale entry cleanup.`); } catch (e) { logClientEvent(clientId, 'error', `Failed to remove local browser data for ${clientId} during stale entry cleanup: ${e.message}`); }
                 }
            }
            // After potential cleanup, `clients[clientId]` should be undefined now, allowing a fresh start.
        }

        // No existing client or existing one was cleaned up, proceed to fork a new process
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
                    logClientEvent(clientId, 'info', 'Client is ready, awaiting session save.');
                    setClientState(clientId, { status: 'ready' });
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
                    resolveInitializationPromise();
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', `Client disconnected: ${msg.reason || 'No reason provided'}`);
                    // A remote disconnect is a problematic state that requires a full cleanup to ensure a clean restart.
                    cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                         logClientEvent(clientId, 'error', `Error during post-disconnect cleanup: ${err.message}`);
                    });
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
                    break;
                case 'error':
                    logClientEvent(clientId, 'error', `Client process error: ${msg.error}`);
                    if (msg.error.includes('Execution context was destroyed')) {
                        logClientEvent(clientId, 'error', `Critical browser error detected. Triggering full client cleanup for ${clientId}.`);
                        cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                            logClientEvent(clientId, 'error', `Error during post-critical-error cleanup: ${err.message}`);
                        });
                    }
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
                    break;
                case 'terminated':
                    // This message confirms the child process has shut down. The calling function
                    // (`cleanupClient`) will handle the subsequent data state management.
                    logClientEvent(clientId, 'info', `Received 'terminated' signal from client process ${clientId}.`);
                    break;
                case 'qr':
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
            if (clients[clientId]?.isInitializing && rejectInitializationPromise) {
                rejectInitializationPromise(new Error(`Client process exited unexpectedly during initialization.`));
            }
            // If entry was in-memory, it's now cleaned up by cleanupClient
        });

        clientProcess.on('error', async (error) => {
            logClientEvent(clientId, 'error', `Client process ${clientId} encountered an error: ${error.message}. Triggering full cleanup.`);
            // A process-level error is critical and requires a full cleanup.
            await cleanupClient(clientId, { fullCleanup: true }).catch(err => {
                logClientEvent(clientId, 'error', `Error during error cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && rejectInitializationPromise) {
                rejectInitializationPromise(new Error(`Client process error during initialization: ${error.message}`));
            }
        });
    });
};

/**
 * Initiates a GRACEFUL shutdown of a client.
 * This function is called for standard termination requests (e.g., from an API endpoint).
 * It stops the client process but preserves all session data on disk, in Mongo, and in Redis.
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

