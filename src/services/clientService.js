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

        if (clients[clientId]?.isInitializing) {
            console.log(`Client ${clientId} is already being initialized.`);
            return reject(new Error('Client is already being initialized'));
        }

        const clientProcess = fork(path.join(SERVICES_DIR, 'clientProcess.js'), [clientId]);

        clients[clientId] = {
            process: clientProcess,
            isActive: false,
            isDestroying: false,
            isInitializing: true,
        };

        clientProcess.on('message', (msg) => {
            if (!msg || typeof msg.type !== 'string') return;

            switch (msg.type) {
                case 'ready':
                    clients[clientId].isActive = true;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'info', 'Client is ready');
                    break;
                case 'disconnected':
                    clients[clientId].isActive = false;
                    logClientEvent(clientId, 'warn', 'Client is disconnected');
                    break;
                case 'auth_failure':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Authentication failure: ${msg.error}`);
                    break;
                case 'error':
                    clients[clientId].isActive = false;
                    clients[clientId].isInitializing = false;
                    logClientEvent(clientId, 'error', `Error: ${msg.error}`);
                    break;
                case 'terminated':
                    clients[clientId].isActive = false;
                    clients[clientId].isDestroying = false;
                    delete clients[clientId];
                    logClientEvent(clientId, 'info', 'Client terminated and cleaned up');
                    break;
                case 'qr':
                case 'message_sent': 
                    break;   
                default:
                    logClientEvent(clientId, 'warn', `Unknown message type: ${msg.type}`);
            }
        });

        clientProcess.on('exit', (code, signal) => {
            clients[clientId].isActive = false;
            clients[clientId].isInitializing = false;
            delete clients[clientId];
            logClientEvent(clientId, 'info', `Client process exited with code ${code}, signal ${signal}`);
        });

        clientProcess.on('error', (error) => {
            clients[clientId].isActive = false;
            clients[clientId].isInitializing = false;
            logClientEvent(clientId, 'error', `Client process error: ${error.message}`);
            reject(error);
        });

        resolve();
    });
};

const terminateClient = (clientId) => {
    const clientEntry = clients[clientId];

    if (!clientEntry) {
        console.log(`Client ${clientId} does not exist.`);
        logClientEvent(clientId, 'warn', 'Client does not exist');
        return;
    }

    if (clientEntry.isDestroying) {
        console.log(`Client ${clientId} is already being terminated.`);
        logClientEvent(clientId, 'info', 'Client termination already in progress');
        return;
    }

    clientEntry.isDestroying = true;
    clientEntry.process.send({ type: 'terminate' });

    clientEntry.process.once('message', (msg) => {
        if (msg.type === 'terminated') {
            delete clients[clientId];
            logClientEvent(clientId, 'info', 'Client terminated and cleaned up');
        }
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

const getClient = (clientId) => clients[clientId];
const getAllClients = () => clients;

module.exports = {
    initializeClient,
    getClient,
    getAllClients,
    terminateClient,
    terminateAllClientsService
};

