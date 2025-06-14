const redis = require('../config/redisClient');
const { logServerEvent } = require('../utils/logUtils');

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
 * On startup, finds and terminates any orphaned client processes from a previous run.
 */
const cleanupOrphanedClients = async () => {
    logServerEvent('info', 'Starting cleanup of orphaned client processes...');
    const states = await getAllClientStates();
    if (states.length === 0) {
        logServerEvent('info', 'No persisted client states found. No cleanup needed.');
        return;
    }

    for (const state of states) {
        const { clientId, pid } = state;
        if (!clientId || !pid) continue;

        const processId = parseInt(pid, 10);
        try {
            // Check if the process is still running. process.kill(pid, 0) throws if not found.
            process.kill(processId, 0);
            logServerEvent('warn', `Found orphaned client process for clientId ${clientId} with PID ${processId}. Terminating...`);
            // If it's running, terminate it.
            process.kill(processId, 'SIGTERM');
        } catch (e) {
            // If e.code is 'ESRCH', the process doesn't exist, which is good.
            if (e.code !== 'ESRCH') {
                logServerEvent('error', `Error checking/terminating orphaned process PID ${processId} for client ${clientId}: ${e.message}`);
            }
        } finally {
            // Clean up the state from Redis regardless.
            await deleteClientState(clientId);
            logServerEvent('info', `Cleaned up Redis state for client ${clientId}.`);
        }
    }
    logServerEvent('info', 'Orphaned client cleanup complete.');
};


module.exports = {
    setClientState,
    getClientState,
    getAllClientStates,
    deleteClientState,
    cleanupOrphanedClients
}; 