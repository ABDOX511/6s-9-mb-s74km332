const path = require('path');
const { SERVICES_DIR, UTILS_DIR } = require('../config/paths');
const wrap = require('../middlewares/asyncWrapper');

const {
  getClient,
  terminateClient,
  getAllClients,
  terminateAllClientsService,
  initializeClient
} = require(path.join(SERVICES_DIR, 'clientService'));

const { logClientEvent } = require(path.join(UTILS_DIR, 'logUtils'));

// POST /api/clients/add
exports.addClient = wrap(async (req, res) => {
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
});

// POST /api/clients/terminate/:id
exports.terminateClient = wrap(async (req, res) => {
  const { id: clientId } = req.params;
  if (!clientId) {
      return res.status(400).json({ message: 'Client ID is required' });
  }

  terminateClient(clientId);
  res.json({ message: `Client ${clientId} terminated successfully` });
});

// POST /api/clients/end
exports.terminateClients = wrap(async (req, res) => {
    const { clientId } = req.body;

    if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required' });
    }

    let clientsToTerminate = {};

    if (clientId === 'all') {
        clientsToTerminate = getAllClients();
    } else if (Array.isArray(clientId)) {
        const clientIds = clientId.flatMap(id => id.split(',').map(id => id.trim()));
        clientsToTerminate = clientIds.reduce((acc, id) => {
            const client = getClient(id);
            if (client) {
                acc[id] = client;
            }
            return acc;
        }, {});
    } else if (typeof clientId === 'string') {
        const clientIds = clientId.split(',').map(id => id.trim());
        clientsToTerminate = clientIds.reduce((acc, id) => {
            const client = getClient(id);
            if (client) {
                acc[id] = client;
            }
            return acc;
        }, {});
    } else {
        return res.status(400).json({ message: 'Invalid clientId format' });
    }

    if (Object.keys(clientsToTerminate).length === 0) {
        return res.status(404).json({ message: 'No clients found to terminate' });
    }

    await terminateAllClientsService();
    logClientEvent('all', 'info', 'Requested clients terminated successfully');
    res.json({ message: 'Requested clients terminated successfully' });
});

exports.getQrCode = wrap(async (req, res) => {
    const { userID } = req.params;
    if (!userID) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    let clientEntry = getClient(userID);

    if (clientEntry && clientEntry.isActive) {
        return res.json({ message: 'Client is already active' });
    }

    try {
        // If client doesn't exist or isn't initializing, start it.
        if (!clientEntry || !clientEntry.isInitializing) {
            // Start initialization but don't wait for it to complete here
            initializeClient(userID).catch(err => {
                // The promise rejection is handled by the caller of initializeClient,
                // but we log it here for visibility during the QR flow.
                logClientEvent(userID, 'error', `Background initialization failed: ${err.message}`);
            });
            // Re-fetch clientEntry to get the updated object with qrPromise
            clientEntry = getClient(userID);
            if (!clientEntry) {
                // This case should ideally not happen if initializeClient successfully forks a process
                return res.status(500).json({ message: `Failed to initialize client process for ${userID}.` });
            }
        }
        
        // Wait specifically for the QR code from the clientEntry's promise
        const qr = await clientEntry.qrPromise;
        res.json({ qr });

    } catch (error) {
        res.status(500).json({ message: `Failed to get QR code for client ${userID}: ${error.message}` });
    }
});

exports.streamQrUpdates = wrap(async (req, res) => {
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
        }
    };

    try {
        // Start initialization in the background, don't await here.
        initializeClient(userID).catch(err => {
            // Log this error but don't stop the SSE stream
            logClientEvent(userID, 'error', `Background SSE client initialization failed: ${err.message}`);
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
                })
            ]).catch(err => {
                // Catch any uncaught errors from the race
                logClientEvent(userID, 'error', `Error in qrPromise race for SSE: ${err.message}`);
            });
        } else if (clientEntry.isActive) {
            res.write('data: ' + JSON.stringify({ message: 'Client is already active' }) + '\n\n');
        }

        // Handle client disconnect (browser closing connection)
        req.on('close', () => {
            logClientEvent(userID, 'info', 'SSE connection closed by client.');
            if (clientEntry) {
                clientEntry.process.off('message', onQR);
            }
        });

    } catch (error) {
        logClientEvent(userID, 'error', `SSE stream error for client ${userID}: ${error.message}`);
        res.write('data: ' + JSON.stringify({ error: error.message || 'Failed to start QR stream' }) + '\n\n');
        res.end(); // End the stream on critical error
    }
});
