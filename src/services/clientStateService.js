const redis = require('../config/redisClient');
const { logServerEvent } = require('../utils/logUtils');
const path = require('path');
const fs = require('fs-extra'); // Ensure fs-extra is imported for pathExists and remove

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

    const ACTION = {
        IGNORE: 'ignore',
        SOFT: 'soft', // Update Redis state to disconnected, preserve local data
        HARD: 'hard'   // Terminate process, delete Redis state, delete local data
    };

    for (const state of states) {
        const { clientId, pid, status } = state; // Get status from Redis state
        if (!clientId) continue;

        let processIsRunning = false;

        // Step 1: Check if the process associated with this PID (if any) is actually running.
        if (pid) {
            const processId = parseInt(pid, 10);
            try {
                process.kill(processId, 0); // Check if the process exists (throws if not)
                processIsRunning = true;
                logServerEvent('warn', `Found unexpectedly running process for clientId ${clientId} with PID ${processId}.`);
            } catch (e) {
                if (e.code !== 'ESRCH') {
                    // ESRCH means process doesn't exist, which is expected after a server restart
                    // For any other error, log it as problematic.
                    logServerEvent('error', `Error checking process PID ${processId} for client ${clientId}: ${e.message}. Treating as non-running.`);
                }
                processIsRunning = false; // Ensure it's false if there was an error or ESRCH
            }
        }

        // Step 2: Decide on cleanup action based on process status and state from Redis
        let action = ACTION.IGNORE;

        if (processIsRunning) {
            action = ACTION.HARD; // Running process that shouldn't be implies hard cleanup
        } else if (['auth_failure', 'init_error'].includes(status)) {
            action = ACTION.HARD; // Critical errors require hard cleanup
        } else if (status !== 'disconnected' && status !== 'active' && status !== 'ready' && status !== 'qr_ready') {
            // If not running, and not explicitly disconnected/active/ready/qr_ready, consider it stale and soft cleanup
            action = ACTION.SOFT;
        }

        switch (action) {
            case ACTION.HARD:
                logServerEvent(clientId, 'info', `Performing HARD cleanup for client ${clientId} (PID: ${pid}, Status: ${status}).`);
                if (processIsRunning && pid) {
                    try {
                        process.kill(parseInt(pid, 10), 'SIGTERM'); // Terminate the process
                        logServerEvent(clientId, 'info', `Terminated orphaned process PID ${pid} for client ${clientId}.`);
                    } catch (e) {
                        logServerEvent('error', `Failed to terminate orphaned process PID ${pid} for client ${clientId}: ${e.message}`);
                    }
                }
                await deleteClientState(clientId).catch(err => logServerEvent('error', `Error deleting Redis state during hard cleanup for ${clientId}: ${err.message}`));
                const clientAuthDirHard = path.join(path.resolve(__dirname, '..', '..', 'data', '.wwebjs_auth'), `session-${clientId}`);
                if (await fs.pathExists(clientAuthDirHard)) {
                    try {
                        await fs.remove(clientAuthDirHard);
                        logServerEvent(clientId, 'info', `Removed local browser data for ${clientId} during hard cleanup.`);
                    } catch (e) {
                        logServerEvent('error', `Failed to remove local browser data for ${clientId} during hard cleanup: ${e.message}`);
                    }
                }
                break;
            case ACTION.SOFT:
                logServerEvent(clientId, 'info', `Performing SOFT cleanup for client ${clientId} (Status: ${status}).`);
                await setClientState(clientId, { status: 'disconnected' }).catch(err => {
                    logServerEvent('error', `Failed to set Redis status to 'disconnected' during soft cleanup for ${clientId}: ${err.message}`);
                });
                // For soft cleanup, we *preserve* local data and don't delete from Redis
                logServerEvent(clientId, 'info', `Client ${clientId} process not running. Updated Redis status to 'disconnected'. Local session data preserved.`);
                break;
            case ACTION.IGNORE:
                logServerEvent(clientId, 'info', `Client ${clientId} (Status: ${status}, PID: ${pid ? 'running' : 'not running'}). No cleanup action needed.`);
                break;
        }
    }
    logServerEvent('info', 'Client state reconciliation complete.');
};

module.exports = {
    setClientState,
    getClientState,
    getAllClientStates,
    deleteClientState,
    cleanupOrphanedClients
}; 