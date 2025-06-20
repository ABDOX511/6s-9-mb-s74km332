const path = require('path');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');
const {
  getClient,
  terminateClient,
  getAllClients,
  terminateAllClientsService,
  initializeClient
} = require(path.join(SERVICES_DIR, 'clientService'));
const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const { getClientState } = require(path.join(SERVICES_DIR, 'clientStateService')); // Import getClientState

// POST /api/clients/add
exports.addClient = async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required' });
    }
    // No longer awaiting. Initialization will happen in the background.
    initializeClient(clientId).catch(err => {
        // Log the error but don't block the response. The user will see status via other means.
        logClientEvent(clientId, 'error', `Background initialization failed: ${err.message}`);
    });
    res.status(202).json({ message: `Client ${clientId} initialization process started.` });
};

// POST /api/clients/terminate/:id
exports.terminateClient = async (req, res) => {
  const { id: clientId } = req.params;
  if (!clientId) {
      return res.status(400).json({ message: 'Client ID is required' });
  }

  await terminateClient(clientId);
  res.json({ message: `Client ${clientId} terminated successfully` });
};

// POST /api/clients/end
exports.terminateClients = async (req, res) => {
    const { clientId } = req.body;

    if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required' });
    }

    let clientsToTerminate;

    if (clientId === 'all') {
        clientsToTerminate = getAllClients();
    } else {
        const clientIds = (Array.isArray(clientId) ? clientId : [clientId])
            .flatMap(id => String(id).split(','))
            .map(id => id.trim())
            .filter(id => id);

        clientsToTerminate = clientIds.reduce((acc, id) => {
            const client = getClient(id);
            if (client) {
                acc[id] = client;
            }
            return acc;
        }, {});
    }

    if (Object.keys(clientsToTerminate).length === 0) {
        return res.status(404).json({ message: 'No clients found to terminate' });
    }

    if (clientId === 'all') {
        await terminateAllClientsService();
        logClientEvent('all', 'info', 'All clients terminated successfully.');
        return res.json({ message: 'All clients terminated successfully.' });
    }

    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(5); // Concurrently terminate up to 5 clients

    const clientIds = Object.keys(clientsToTerminate);
    const terminationPromises = clientIds.map(id =>
        limit(() => terminateClient(id))
    );

    await Promise.all(terminationPromises);

    const terminatedIds = clientIds.join(', ');
    logClientEvent('multiple', 'info', `Terminated clients: ${terminatedIds}`);
    res.json({ message: `Successfully terminated clients: ${terminatedIds}` });
};

// GET /api/clients/status/:userID
exports.getClientStatus = async (req, res) => {
    // Add headers to prevent caching for this endpoint
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    const { userID } = req.params;
    if (!userID) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    const clientEntry = getClient(userID);
    const clientState = await getClientState(userID); // Fetch Redis state regardless

    logClientEvent(userID, 'debug', `getClientStatus: In-memory clientEntry: ${JSON.stringify(clientEntry)}`);
    logClientEvent(userID, 'debug', `getClientStatus: Redis clientState: ${JSON.stringify(clientState)}`);

    // Client is only truly connected if it exists in memory AND is active/ready
    if (clientEntry && (clientEntry.isActive || clientEntry.isReady)) {
        logClientEvent(userID, 'debug', `getClientStatus: Returning connected: true based on in-memory state.`);
        return res.json({ connected: true });
    } else {
        // If no in-memory client or not active/ready, always return false
        // Redis state alone is not sufficient - we need an actual running process
        logClientEvent(userID, 'debug', `getClientStatus: Returning connected: false. In-memory: ${!!clientEntry}, Redis: ${clientState?.status || 'none'}`);
        return res.json({ connected: false });
    }
};

exports.streamQrUpdates = async (req, res) => {
    const { userID } = req.params;
    if (!userID) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    // Set headers for SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Send initial connection message
    res.write('data: ' + JSON.stringify({ status: 'connecting' }) + '\n\n');

    // Check if client is already active/ready before proceeding with initialization
    const existingClient = getClient(userID);
    if (existingClient && (existingClient.isActive || existingClient.isReady)) {
        logClientEvent(userID, 'info', `SSE stream requested for client ${userID}, but client is already active/ready. Not re-initializing.`);
        res.write('data: ' + JSON.stringify({ message: 'Client already connected' }) + '\n\n');
        return res.end();
    }

    // Helper to wait for client entry and its process
    const waitForClientEntryAndProcess = (userId) => {
        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                const entry = getClient(userId);
                if (entry && entry.process) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve(entry);
                }
            }, 200); // Check every 200ms

            const timeout = setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timed out waiting for client process.'));
            }, 15000); // 15-second timeout
        });
    };

    // Create QR event handler (using clientEntry from closure)
    const onQR = (msg) => {
        if (msg.type === 'qr' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ qr: msg.qr }) + '\n\n');
        } else if (msg.type === 'ready' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ message: 'Client is ready' }) + '\n\n');
        } else if (msg.type === 'disconnected' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ message: 'Client disconnected' }) + '\n\n');
        } else if (msg.type === 'error' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ error: msg.error }) + '\n\n');
        } else if (msg.type === 'auth_failure' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ error: `Authentication failed: ${msg.error}` }) + '\n\n');
        } else if (msg.type === 'init_error' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ error: `Initialization failed: ${msg.error}` }) + '\n\n');
        } else if (msg.type === 'terminated' && msg.clientId === userID) { // Handle explicit termination from child process
            logClientEvent(userID, 'info', `Client ${userID} reported itself terminated via SSE.`);
            res.write('data: ' + JSON.stringify({ message: 'Client terminated' }) + '\n\n');
            res.end(); // End the stream if the client explicitly terminated
        }
    };

    try {
        // Start initialization in the background, don't await here.
        initializeClient(userID).catch(err => {
            // Log this error but don't stop the SSE stream
            logClientEvent(userID, 'error', `Background SSE client initialization failed: ${err.message}`);
            // If initialization fails, proactively send an error to the client
            if (!res.writableEnded) {
                res.write('data: ' + JSON.stringify({ error: `Initialization failed: ${err.message}` }) + '\n\n');
                res.end(); // Close the stream immediately on initialization error
            }
            // Crucially, perform a full cleanup on backend if initialization fails
            terminateClient(userID, { fullCleanup: true }).catch(cleanupErr => {
                logClientEvent(userID, 'error', `Error during cleanup after failed background initialization for ${userID}: ${cleanupErr.message}`);
            });
        });

        // Wait for the client entry and process to be available
        const clientEntry = await waitForClientEntryAndProcess(userID);

        // Attach event listener immediately
        clientEntry.process.on('message', onQR);

        // Check if QR is already available or if the client is already active
        if (clientEntry.qrPromise) {
            // Use Promise.race to handle both resolution and rejection of qrPromise
            Promise.race([
                clientEntry.qrPromise.then(qr => {
                    if (qr) res.write('data: ' + JSON.stringify({ qr: qr }) + '\n\n');
                }),
                clientEntry.initializationPromise.catch(err => {
                    // If initializationPromise rejects (e.g., auth_failure from background)
                    res.write('data: ' + JSON.stringify({ error: `Initialization failed: ${err.message}` }) + '\n\n');
                    res.end(); // Close the stream if initializationPromise rejects
                })
            ]).catch(err => {
                // Catch any uncaught errors from the race
                logClientEvent(userID, 'error', `Error in qrPromise race for SSE: ${err.message}`);
                if (!res.writableEnded) {
                    res.write('data: ' + JSON.stringify({ error: `QR stream error: ${err.message}` }) + '\n\n');
                    res.end(); // Close the stream on unhandled race error
                }
                // Perform full cleanup on backend if QR promise or initialization promise rejects unexpectedly
                terminateClient(userID, { fullCleanup: true }).catch(cleanupErr => {
                    logClientEvent(userID, 'error', `Error during cleanup after failed QR/Initialization race for ${userID}: ${cleanupErr.message}`);
                });
            });

            // Set a timeout for the QR code stream itself to close if not ready within 2 minutes
            const qrStreamTimeout = setTimeout(() => {
                if (res.writableEnded) return; // If response is already ended, do nothing
                logClientEvent(userID, 'warn', `QR stream for ${userID} timed out after 2 minutes.`);
                res.write('data: ' + JSON.stringify({ error: 'QR code stream timed out. Please refresh the page.' }) + '\n\n');
                res.end();
            }, 120000); // 2 minutes

            // Handle client disconnection (browser tab closed)
            req.on('close', () => {
                logClientEvent(userID, 'info', `SSE connection for client ${userID} closed by client.`);
                clearTimeout(qrStreamTimeout); // Clear the timeout if it's still active
                clientEntry.process.off('message', onQR); // Remove the listener

                // DO NOT terminate the client when SSE closes - let it keep running
                // The client should persist so it can be used when the popup is reopened
                logClientEvent(userID, 'info', `Client ${userID} will continue running in background.`);

                // Ensure response is ended if not already
                if (!res.writableEnded) {
                    res.end();
                }
            });

        } else if (clientEntry.isReady || clientEntry.isActive) {
            // If client is already ready, send ready message and close stream
            res.write('data: ' + JSON.stringify({ message: 'Client is ready' }) + '\n\n');
            res.end();
        } else {
            // Fallback for unexpected states, or if process hasn't sent QR/ready yet
            res.write('data: ' + JSON.stringify({ message: 'Waiting for client to become ready...' }) + '\n\n');
        }

    } catch (error) {
        logClientEvent(userID, 'error', `Error in streamQrUpdates for ${userID}: ${error.message}`);
        if (!res.writableEnded) {
            res.write('data: ' + JSON.stringify({ error: `Server error: ${error.message}` }) + '\n\n');
            res.end();
        }
    }
};
