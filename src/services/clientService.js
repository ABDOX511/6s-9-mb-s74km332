const path = require('path');
const { fork } = require('child_process');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { setClientState, deleteClientState, getClientState } = require('./clientStateService');


const clients = {};

/**
 * Safely terminates an existing client process and cleans up its state.
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
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    logClientEvent(clientId, 'error', 'Existing client termination timed out. Killing process.');
                    existingClientEntry.process.kill('SIGKILL'); // Force kill if timeout
                    resolve();
                }, 10000); // 10 seconds timeout

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

        // Clean up in-memory and Redis state immediately after attempting termination
        delete clients[clientId];
        await deleteClientState(clientId).catch(err => {
            logClientEvent(clientId, 'error', `Failed to delete Redis state for ${clientId} during pre-initialization cleanup: ${err.message}`);
        });
        logClientEvent(clientId, 'info', `Cleaned up state for existing client ${clientId}.`);
    }
};

const initializeClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        // Step 1: Check for and terminate any existing process for this clientId
        if (clients[clientId]) {
            logClientEvent(clientId, 'warn', `Re-initialization request for active/initializing client ${clientId}. Attempting to safely terminate existing instance.`);
            await safeTerminateExistingClient(clientId);
        }

        // Re-check after attempting termination, though `clients[clientId]` should be undefined now.
        if (clients[clientId]?.isActive) {
            logClientEvent(clientId, 'info', `Client ${clientId} is already active.`);
            return resolve();
        }

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
            // Defensive check: Ensure clients[clientId] still exists before accessing
            if (!clients[clientId]) {
                logClientEvent(clientId, 'warn', `Received message for ${clientId} but client entry is missing. Message type: ${msg.type}`);
                return; // Ignore message if client entry is gone
            }

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
                    // If disconnected, clean up this process. This helps prevent multiple instances.
                    safeTerminateExistingClient(clientId).catch(err => {
                         logClientEvent(clientId, 'error', `Error during post-disconnect cleanup: ${err.message}`);
                    });
                    break;
                case 'auth_failure':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Authentication failure: ${msg.error}`);
                    deleteClientState(clientId); // Clean up Redis state on failure
                    rejectInitializationPromise(new Error(`Authentication failure: ${msg.error}`));
                    // Also reject the QR promise if it hasn't been resolved yet
                    rejectQrPromise(new Error(`Authentication failed before QR for ${clientId}: ${msg.error}`));
                    // Clean up process on auth failure
                    safeTerminateExistingClient(clientId).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-auth_failure cleanup: ${err.message}`);
                    });
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
                    // Clean up process on init failure
                    safeTerminateExistingClient(clientId).catch(err => {
                        logClientEvent(clientId, 'error', `Error during post-init_error cleanup: ${err.message}`);
                    });
                    break;
                case 'terminated':
                    // This message comes from the child process when it has successfully terminated itself.
                    // The parent can now safely remove its in-memory reference and Redis state.
                    if (clients[clientId]) {
                        clients[clientId].isActive = false;
                        clients[clientId].isDestroying = false;
                        delete clients[clientId];
                        deleteClientState(clientId); // Final cleanup of Redis state
                        logClientEvent(clientId, 'info', 'Client terminated and cleaned up');
                    }
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

        clientProcess.on('exit', async (code, signal) => {
            // Defensive check: Ensure clients[clientId] still exists
            if (clients[clientId]) {
                const wasInitializing = clients[clientId].isInitializing;
                delete clients[clientId];
                // Only delete Redis state if the process exited unexpectedly and wasn't part of a planned termination
                await deleteClientState(clientId).catch(err => {
                    logClientEvent(clientId, 'error', `Failed to delete Redis state on unexpected exit for ${clientId}: ${err.message}`);
                });
                logClientEvent(clientId, 'info', `Client process exited with code ${code}, signal ${signal}`);
                if (wasInitializing) {
                    rejectInitializationPromise(new Error(`Client process exited unexpectedly during initialization.`));
                }
            } else {
                 logClientEvent(clientId, 'warn', `Client process ${clientId} exited unexpectedly, but no in-memory entry found (already cleaned up or never fully added). Code: ${code}, Signal: ${signal}`);
            }
        });

        clientProcess.on('error', async (error) => {
            // Defensive check: Ensure clients[clientId] still exists
            if (clients[clientId]) {
                clients[clientId].isInitializing = false;
                logClientEvent(clientId, 'error', `Client process error: ${error.message}`);
                // Only delete Redis state if the process error was critical and wasn't part of a planned termination
                await deleteClientState(clientId).catch(err => {
                    logClientEvent(clientId, 'error', `Failed to delete Redis state on process error for ${clientId}: ${err.message}`);
                });
                rejectInitializationPromise(error);
            } else {
                logClientEvent(clientId, 'error', `Client process error for ${clientId}, but no in-memory entry found. Error: ${error.message}`);
            }
        });
    });
};

const terminateClient = (clientId) => {
    return new Promise(async (resolve, reject) => {
        const clientEntry = clients[clientId];
        if (!clientEntry) {
            logClientEvent(clientId, 'warn', `Attempted to terminate non-existent client ${clientId}. Checking Redis state.`);
            // If not in-memory, check Redis. If found, delete from Redis.
            const stateInRedis = await getClientState(clientId);
            if (stateInRedis && Object.keys(stateInRedis).length > 0) {
                logClientEvent(clientId, 'info', `Client ${clientId} found in Redis but not in-memory. Deleting Redis state.`);
                await deleteClientState(clientId);
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
            logClientEvent(clientId, 'error', 'Client termination timed out.');
            // Clean up in-memory and Redis state even on timeout
            delete clients[clientId];
            deleteClientState(clientId); // Final cleanup
            reject(new Error(`Termination timed out for client ${clientId}`));
        }, 30000); // 30-second timeout

        // Listen for the 'terminated' message from the child process (clean shutdown)
        clientEntry.process.once('message', (msg) => {
            if (msg.type === 'terminated') {
                clearTimeout(terminationTimeout);
                // The child process handles its own cleanup and signals parent. Parent just confirms.
                // In-memory and Redis state should be cleaned up by the child's `terminated` handler.
                if (clients[clientId]) { // Defensive check
                    delete clients[clientId];
                } else {
                    logClientEvent(clientId, 'warn', `Client ${clientId} already removed from in-memory during termination. Redis state should be handled by client process.`);
                }
                deleteClientState(clientId); // Ensure Redis state is gone
                logClientEvent(clientId, 'info', 'Client terminated and cleaned up successfully');
                resolve();
            }
        });

        // Handle case where process exits unexpectedly (e.g., crashes or is killed externally)
        clientEntry.process.once('exit', async (code, signal) => {
            clearTimeout(terminationTimeout);
            // If process exits, it's considered terminated, even if not clean.
            if (clients[clientId]) { // Defensive check
                delete clients[clientId];
            } else {
                logClientEvent(clientId, 'warn', `Client ${clientId} already removed from in-memory during exit. Redis state should be handled by client process.`);
            }
            await deleteClientState(clientId); // Ensure Redis state is gone
            logClientEvent(clientId, 'warn', `Client process for ${clientId} exited unexpectedly during termination. Code: ${code}, Signal: ${signal}.`);
            resolve(); // Resolve to not block the shutdown process
        });
    });
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

const getClient = (clientId) => {
    return clients[clientId];
};

const getAllClients = () => {
    return clients; // Returns the in-memory clients object
};

module.exports = {
    initializeClient,
    getClient,
    getAllClients,
    terminateClient,
    terminateAllClientsService,
    sendImmediateMessage
};

