const redis = require('../config/redisClient');
const { logServerEvent } = require('../utils/logUtils');
const mongoose = require('mongoose');
const path = require('path');

const CLIENT_STATE_PREFIX = 'whatsapp:clients:';

const getClientStateKey = (clientId) => `${CLIENT_STATE_PREFIX}${clientId}`;

const setClientState = async (clientId, state) => {
    const key = getClientStateKey(clientId);
    await redis.hmset(key, state);
};

const getClientState = async (clientId) => {
    const key = getClientStateKey(clientId);
    return await redis.hgetall(key);
};

const getAllClientStates = async () => {
    const keys = await redis.keys(`${CLIENT_STATE_PREFIX}*`);
    if (!keys.length) {
        return [];
    }
    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.hgetall(key));
    const results = await pipeline.exec();
    // results is an array of [error, data]. Filter out errors and map to data.
    return results.filter(r => r[0] === null).map(r => r[1]);
};

const deleteClientState = async (clientId) => {
    const key = getClientStateKey(clientId);
    await redis.del(key);
};

/**
 * Deletes a client's session data from MongoDB (including GridFS collections).
 * This targets collections created by wwebjs-mongo's RemoteAuth.
 * @param {string} clientId
 */
const deleteClientSessionFromMongo = async (clientId) => {
    logServerEvent('info', `Attempting to delete MongoDB session data for client ${clientId}...`);
    try {
        // Ensure mongoose connection is established. This might need to be called in main server start.
        if (mongoose.connection.readyState !== 1) {
            logServerEvent('warn', `Mongoose not connected for MongoDB cleanup for client ${clientId}. Skipping.`);
            return;
        }

        const db = mongoose.connection.db;
        const chunksCollectionName = `whatsapp-RemoteAuth-${clientId}.chunks`;
        const filesCollectionName = `whatsapp-RemoteAuth-${clientId}.files`;
        const sessionsCollectionName = 'sessions'; // Default collection name for main session entries

        // Delete the main session entry from the 'sessions' collection
        await db.collection(sessionsCollectionName).deleteOne({ id: clientId });
        logServerEvent('info', `Deleted main session entry for ${clientId} from '${sessionsCollectionName}' collection.`);

        // Drop GridFS chunks and files collections if they exist
        const collections = await db.listCollections().toArray();
        const existingCollectionNames = collections.map(c => c.name);

        if (existingCollectionNames.includes(chunksCollectionName)) {
            await db.collection(chunksCollectionName).drop();
            logServerEvent('info', `Dropped GridFS chunks collection: ${chunksCollectionName}`);
        } else {
            logServerEvent('debug', `GridFS chunks collection ${chunksCollectionName} not found, skipping drop.`);
        }

        if (existingCollectionNames.includes(filesCollectionName)) {
            await db.collection(filesCollectionName).drop();
            logServerEvent('info', `Dropped GridFS files collection: ${filesCollectionName}`);
        } else {
            logServerEvent('debug', `GridFS files collection ${filesCollectionName} not found, skipping drop.`);
        }

        logServerEvent('info', `MongoDB session data cleanup complete for client ${clientId}.`);
    } catch (error) {
        logServerEvent('error', `Failed to delete MongoDB session data for client ${clientId}: ${error.message}`);
        // Do not rethrow, as other cleanup steps might still succeed.
    }
};

/**
 * On startup, finds and handles client processes that might be in an inconsistent state.
 * It differentiates between truly orphaned, running processes and simply non-running sessions.
 */
const cleanupOrphanedClients = async () => {
    logServerEvent('info', 'Starting cleanup and reconciliation of client states...');
    const states = await getAllClientStates();
    if (states.length === 0) {
        logServerEvent('info', 'No persisted client states found in Redis. No cleanup needed.');
        return;
    }

    for (const state of states) {
        const { clientId, pid, status } = state; // Get status from Redis state
        if (!clientId) continue;

        let processIsRunning = false;
        let requiresFullCleanup = false;

        // Step 1: Check if the process associated with this PID (if any) is actually running.
        if (pid) {
            const processId = parseInt(pid, 10);
            try {
                process.kill(processId, 0); // Check if the process exists (throws if not)
                processIsRunning = true;
                // If the process is running, and it's not meant to be, it's an orphaned process
                logServerEvent('warn', `Found unexpectedly running process for clientId ${clientId} with PID ${processId}. Marked for full cleanup.`);
                requiresFullCleanup = true;
            } catch (e) {
                if (e.code !== 'ESRCH') {
                    // This is an unexpected error when checking process, log it.
                    logServerEvent('error', `Error checking process PID ${processId} for client ${clientId}: ${e.message}`);
                    requiresFullCleanup = true; // Treat as problematic
                }
                // If e.code === 'ESRCH', process doesn't exist, which is the expected case after a server restart.
            }
        }

        // Step 2: Decide on cleanup action based on process status and state from Redis
        if (requiresFullCleanup) {
            // Case A: Truly orphaned process (unexpectedly running or check failed). Terminate and clean all.
            if (processIsRunning) {
                 try {
                    process.kill(parseInt(pid, 10), 'SIGTERM'); // Terminate the process
                    logServerEvent('info', `Terminated orphaned process PID ${pid} for client ${clientId}.`);
                 } catch (e) {
                    logServerEvent('error', `Failed to terminate orphaned process PID ${pid} for client ${clientId}: ${e.message}`);
                 }
            }
            // Always clean up all persisted data for a problematic orphaned process
            await deleteClientState(clientId).catch(err => logServerEvent('error', `Error deleting Redis state during full cleanup for ${clientId}: ${err.message}`));
            await deleteClientSessionFromMongo(clientId).catch(err => logServerEvent('error', `Error deleting Mongo session during full cleanup for ${clientId}: ${err.message}`));
            // Remove local data as well
            const clientAuthDir = path.join(require('path').resolve(__dirname, '..', '..', 'data', '.wwebjs_auth'), clientId);
            if (await require('fs-extra').pathExists(clientAuthDir)) {
                try {
                    await require('fs-extra').remove(clientAuthDir);
                    logServerEvent('info', `Removed local browser data for ${clientId} during full cleanup.`);
                } catch (e) {
                    logServerEvent('error', `Failed to remove local browser data for ${clientId} during full cleanup: ${e.message}`);
                }
            }
            logServerEvent('info', `Performed full cleanup for problematic client ${clientId}.`);
        } else {
            // Case B: Process is not running (e.g., after server restart), but session might be valid.
            // Do NOT delete the MongoDB session. Only update Redis state if necessary.
            if (status !== 'disconnected' && status !== 'auth_failure' && status !== 'init_error') {
                await setClientState(clientId, { status: 'disconnected' }).catch(err => {
                    logServerEvent('error', `Failed to set Redis status to 'disconnected' for client ${clientId}: ${err.message}`);
                });
                logServerEvent('info', `Client ${clientId} process not running. Updated Redis status to 'disconnected'. MongoDB session preserved.`);
            } else {
                logServerEvent('info', `Client ${clientId} process not running, and already in a terminal state ('${status}'). No further action needed.`);
            }
        }
    }
    logServerEvent('info', 'Client state reconciliation complete.');
};


module.exports = {
    setClientState,
    getClientState,
    getAllClientStates,
    deleteClientState,
    deleteClientSessionFromMongo,
    cleanupOrphanedClients
}; 