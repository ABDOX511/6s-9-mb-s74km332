const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { setClientState, deleteClientState, getClientState, deleteClientSessionFromMongo } = require('./clientStateService');

const fs = require('fs-extra');
const { DATA_AUTH } = require('../config/paths');

const clients = {};

/**
 * Safely terminates an existing client process and cleans up its state.
 * This function is now explicitly called when a problematic state is detected.
 * @param {string} clientId
 * @returns {Promise<void>}
 */
const safeTerminateExistingClient = async (clientId) => {
    const existingClientEntry = clients[clientId];
    if (existingClientEntry) {
        logClientEvent(clientId, 'warn', `Existing client process detected for ${clientId}. Attempting to terminate it gracefully.`);
        try {
            // Send terminate signal to the child process
            existingClientEntry.process.send({ type: 'terminate' });

            // Wait for the process to exit or timeout
            await new Promise((resolve) => { // Removed reject, handle errors internally
                const timeout = setTimeout(() => {
                    logClientEvent(clientId, 'error', `Existing client termination for ${clientId} timed out. Forcibly killing process.`);
                    existingClientEntry.process.kill('SIGKILL'); // Force kill if timeout
                    resolve();
                }, 10000); // 10 seconds timeout

                // Clean up listeners immediately to prevent re-triggering this promise
                existingClientEntry.process.removeAllListeners('exit');
                existingClientEntry.process.removeAllListeners('error');
                existingClientEntry.process.removeAllListeners('message');

                existingClientEntry.process.once('exit', (code, signal) => {
                    clearTimeout(timeout);
                    logClientEvent(clientId, 'info', `Existing client process ${clientId} exited with code ${code}, signal ${signal}.`);
                    resolve();
                });

                existingClientEntry.process.once('error', (error) => {
                    clearTimeout(timeout);
                    logClientEvent(clientId, 'error', `Error during existing client termination for ${clientId}: ${error.message}`);
                    resolve(); // Resolve to proceed, even with error
                });
            });
        } catch (err) {
            logClientEvent(clientId, 'error', `Error sending terminate signal to existing client ${clientId}: ${err.message}`);
        }

        // Ensure all state (in-memory, Redis, Mongo, Local) is cleaned up after attempt to terminate
        delete clients[clientId]; // Remove from in-memory immediately
        await deleteClientState(clientId).catch(err => {
            logClientEvent(clientId, 'error', `Failed to delete Redis state for ${clientId} during cleanup: ${err.message}`);
        });
        await deleteClientSessionFromMongo(clientId).catch(err => {
            logClientEvent(clientId, 'error', `Failed to delete MongoDB session for ${clientId} during cleanup: ${err.message}`);
        });

        const clientAuthDir = path.join(DATA_AUTH, clientId);
        if (await fs.pathExists(clientAuthDir)) {
            try {
                await fs.remove(clientAuthDir);
                logClientEvent(clientId, 'info', `Removed local browser data directory for ${clientId} during cleanup.`);
            } catch (err) {
                logClientEvent(clientId, 'error', `Failed to remove local browser data for ${clientId} during cleanup: ${err.message}`);
            }
        }
        logClientEvent(clientId, 'info', `Completed full state cleanup for existing client ${clientId}.`);
    }
};

const initializeClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        const existingClientEntry = clients[clientId];

        if (existingClientEntry) {
            // Case 1: Client is already active or ready. Do NOT clean up, just return existing.
            if (existingClientEntry.isActive || existingClientEntry.isReady) {
                logClientEvent(clientId, 'info', `Client ${clientId} is already active/ready. Returning existing instance.`);
                return resolve();
            }

            // Case 2: Client is currently initializing. Return existing promise to avoid duplicate initialization.
            if (existingClientEntry.isInitializing && existingClientEntry.initializationPromise) {
                logClientEvent(clientId, 'info', `Client ${clientId} is already being initialized. Returning existing promise.`);
                return existingClientEntry.initializationPromise;
            }

            // Case 3: Client exists in memory but is in a problematic or stale state.
            // This is when we trigger `safeTerminateExistingClient`.
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
                 await safeTerminateExistingClient(clientId);
            } else {
                 // If in-memory entry exists but process is NOT running and state is not explicitly problematic,
                 // it's likely a leftover from an abrupt shutdown. Perform a lighter cleanup of just the data.
                 logClientEvent(clientId, 'info', `Stale in-memory entry for ${clientId} detected (process not running, status not critical). Performing data-only cleanup.`);
                 delete clients[clientId];
                 await deleteClientState(clientId).catch(err => { /* log error */ });
                 await deleteClientSessionFromMongo(clientId).catch(err => { /* log error */ });
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
                    setClientState(clientId, { status: 'disconnected' });
                    // This is a problematic state, trigger full cleanup
                    safeTerminateExistingClient(clientId).catch(err => {
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
                    safeTerminateExistingClient(clientId).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-auth_failure cleanup: ${err.message}`);
                    });
                    break;
                case 'error':
                    logClientEvent(clientId, 'error', `Client process error: ${msg.error}`);
                    if (msg.error.includes('Execution context was destroyed')) {
                        logClientEvent(clientId, 'error', `Critical browser error detected. Triggering full client cleanup for ${clientId}.`);
                        safeTerminateExistingClient(clientId).catch(err => {
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
                    safeTerminateExistingClient(clientId).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-init_error cleanup: ${err.message}`);
                    });
                    break;
                case 'terminated':
                    // Child process explicitly signaled clean termination.
                    // safeTerminateExistingClient should have already been called for full cleanup.
                    if (clients[clientId]) {
                        clients[clientId].isActive = false;
                        clients[clientId].isDestroying = false;
                        delete clients[clientId]; // Remove from in-memory
                        logClientEvent(clientId, 'info', `Client ${clientId} terminated cleanly and in-memory state removed.`);
                    } else {
                        logClientEvent(clientId, 'info', `Client ${clientId} terminated cleanly, but in-memory entry already missing (already handled).`);
                    }
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
            logClientEvent(clientId, 'warn', `Client process ${clientId} exited unexpectedly with code ${code}, signal ${signal}. Triggering cleanup.`);
            // No need for 'if (clients[clientId])' here, safeTerminateExistingClient handles null entry
            await safeTerminateExistingClient(clientId).catch(err => {
                logClientEvent(clientId, 'error', `Error during exit cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && rejectInitializationPromise) {
                rejectInitializationPromise(new Error(`Client process exited unexpectedly during initialization.`));
            }
            // If entry was in-memory, it's now cleaned up by safeTerminateExistingClient
        });

        clientProcess.on('error', async (error) => {
            logClientEvent(clientId, 'error', `Client process ${clientId} encountered an error: ${error.message}. Triggering cleanup.`);
            // No need for 'if (clients[clientId])' here, safeTerminateExistingClient handles null entry
            await safeTerminateExistingClient(clientId).catch(err => {
                logClientEvent(clientId, 'error', `Error during error cleanup for ${clientId}: ${err.message}`);
            });
            // If the initialization promise was still pending, reject it.
            if (clients[clientId]?.isInitializing && rejectInitializationPromise) {
                rejectInitializationPromise(new Error(`Client process error during initialization: ${error.message}`));
            }
        });
    });
};

const terminateClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        const clientEntry = clients[clientId];
        if (!clientEntry) {
            logClientEvent(clientId, 'warn', `Attempted to terminate non-existent client ${clientId}. Performing data cleanup.`);
            // If not in-memory, just perform data cleanup without sending signals
            await deleteClientState(clientId).catch(err => {});
            await deleteClientSessionFromMongo(clientId).catch(err => {});
            const clientAuthDir = path.join(DATA_AUTH, clientId);
            if (await fs.pathExists(clientAuthDir)) {
                try {
                    await fs.remove(clientAuthDir);
                    logClientEvent(clientId, 'info', `Removed local browser data directory for ${clientId} during non-existent termination.`);
                } catch (err) {
                    logClientEvent(clientId, 'error', `Failed to remove local browser data for ${clientId} during non-existent termination: ${err.message}`);
                }
            }
            return resolve(); // Resolve as if terminated
        }

        if (clientEntry.isDestroying) {
            logClientEvent(clientId, 'info', `Client ${clientId} is already being destroyed.`);
            return resolve();
        }

        clientEntry.isDestroying = true;
        logClientEvent(clientId, 'info', `Sending terminate signal to client ${clientId}`);
        setClientState(clientId, { status: 'terminating' }); // Update state in Redis
        clientEntry.process.send({ type: 'terminate' });

        const terminationTimeout = setTimeout(() => {
            logClientEvent(clientId, 'error', `Client termination for ${clientId} timed out. Forcibly cleaning up.`);
            safeTerminateExistingClient(clientId).catch(err => {
                logClientEvent(clientId, 'error', `Error during timeout cleanup for ${clientId}: ${err.message}`);
            });
            reject(new Error(`Termination timed out for client ${clientId}`));
        }, 30000); // 30-second timeout

        // Listen for the 'terminated' message from the child process (clean shutdown)
        clientEntry.process.once('message', async (msg) => {
            if (msg.type === 'terminated') {
                clearTimeout(terminationTimeout);
                logClientEvent(clientId, 'info', `Client ${clientId} signaled clean termination. Performing final cleanup.`);
                safeTerminateExistingClient(clientId).catch(err => { // Call full cleanup
                    logClientEvent(clientId, 'error', `Error during post-terminated message cleanup for ${clientId}: ${err.message}`);
                });
                resolve();
            }
        });

        // Handle case where process exits unexpectedly (e.g., crashes or is killed externally)
        clientEntry.process.once('exit', async (code, signal) => {
            clearTimeout(terminationTimeout);
            logClientEvent(clientId, 'warn', `Client process ${clientId} exited unexpectedly during termination. Code: ${code}, Signal: ${signal}. Performing final cleanup.`);
            safeTerminateExistingClient(clientId).catch(err => { // Call full cleanup
                logClientEvent(clientId, 'error', `Error during exit-after-terminate cleanup for ${clientId}: ${err.message}`);
            });
            resolve(); // Resolve to not block the shutdown process
        });
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

