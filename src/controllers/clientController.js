const path = require('path');
const { SERVICES_DIR, LOGGER_DIR } = require('../config/paths');
const wrap = require('../middlewares/asyncWrapper');

const {
  getClient,
  terminateClient,
  getAllClients,
  terminateAllClientsService,
  initializeClient
} = require(path.join(SERVICES_DIR, 'clientService'));

const { logClientEvent } = require(path.join(LOGGER_DIR, 'logUtils'));

// POST /api/clients/add
exports.addClient = wrap(async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required' });
    }
    await initializeClient(clientId);
    res.json({ message: 'Client initialized successfully' });
});

// POST /api/clients/terminate/:id
exports.terminateClient = wrap(async (req, res) => {
  const { clientId } = req.body;
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
    const { getClient, initializeClient } = require(path.join(SERVICES_DIR, 'clientService'));
    let clientEntry = getClient(userID);
    let qrTimeout;
    let responded = false;
    // Helper to clean up listeners and timeout
    const cleanup = () => {
        if (clientEntry) clientEntry.process.off('message', onQR);
        clearTimeout(qrTimeout);
    };
    // QR event handler
    const onQR = (msg) => {
        if (msg.type === 'qr' && !responded) {
            responded = true;
            cleanup();
            res.json({ qr: msg.qr });
        }
    };
    // If client exists and is active, return immediately
    if (clientEntry && clientEntry.isActive) {
        return res.json({ message: 'Client is already active' });
    }
    // If client exists and is initializing, listen for QR
    if (clientEntry && clientEntry.isInitializing) {
        clientEntry.process.on('message', onQR);
        qrTimeout = setTimeout(() => {
            if (!responded) {
                responded = true;
                cleanup();
                res.status(504).json({ message: 'QR code not received in time' });
            }
        }, 15000);
        return;
    }
    // If client does not exist, set up listener after initializing
    await initializeClient(userID);
    clientEntry = getClient(userID);
    if (!clientEntry) {
        return res.status(404).json({ message: 'Client not found' });
    }
    clientEntry.process.on('message', onQR);
    qrTimeout = setTimeout(() => {
        if (!responded) {
            responded = true;
            cleanup();
            res.status(504).json({ message: 'QR code not received in time' });
        }
    }, 15000);
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

    // Create QR event handler
    const onQR = (msg) => {
        if (msg.type === 'qr' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ qr: msg.qr }) + '\n\n');
        } else if (msg.type === 'ready' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ message: 'Client is ready' }) + '\n\n');
        } else if (msg.type === 'disconnected' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ message: 'Client disconnected' }) + '\n\n');
        } else if (msg.type === 'error' && msg.clientId === userID) {
            res.write('data: ' + JSON.stringify({ error: msg.error }) + '\n\n');
        }
    };

    // Get client entry
    const { getClient, initializeClient } = require(path.join(SERVICES_DIR, 'clientService'));
    let clientEntry = getClient(userID);
    
    // Initialize client if it doesn't exist
    if (!clientEntry) {
        await initializeClient(userID);
        clientEntry = getClient(userID);
        if (!clientEntry) {
            throw new Error('Failed to initialize client');
        }
    }

    // Attach event listener
    clientEntry.process.on('message', onQR);

    // Handle client disconnect
    req.on('close', () => {
        if (clientEntry) {
            clientEntry.process.off('message', onQR);
        }
    });
});
