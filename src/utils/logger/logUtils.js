const fs = require('fs').promises;
const path = require('path');

const { LOGS_SERVER_DIR, LOGS_CLIENTS_DIR } = require('../../config/paths');

// Ensure the existence of a directory synchronously
const ensureDirectoryExists = async (directoryPath) => {
    try {
        await fs.access(directoryPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(directoryPath, { recursive: true });
        } else {
            throw error; // Re-throw other errors
        }
    }
};

// Generate the log file path based on the agent's ID and the current date
const getLogFileName = async (userId, logType = 'default') => {
    if (typeof userId !== 'string' && typeof userId !== 'number') {
        throw new TypeError('userId must be a string or number');
    }

    const date = new Date();
    const dateString = `${(date.getMonth() + 1).toString().padStart(2, '0')}_${date.getDate().toString().padStart(2, '0')}_${date.getFullYear()}`;

    let baseLogDirectory;
    let finalLogDirectory;

    if (userId === 'server') {
        baseLogDirectory = LOGS_SERVER_DIR;
        finalLogDirectory = baseLogDirectory; // Server logs are directly in logs/server
    } else {
        baseLogDirectory = LOGS_CLIENTS_DIR;
        finalLogDirectory = path.join(baseLogDirectory, userId.toString()); // Client logs are in logs/clients/clientId/
    }
    
    await ensureDirectoryExists(finalLogDirectory);

    const fileName = `${dateString}_${logType}.log`;
    return path.join(finalLogDirectory, fileName);
};

// Log the message status, phone number, status, error, and timestamp
const logMessageStatus = async (userId, phoneNumber, status, leadID, error = '') => {
    if (!userId) {
        throw new TypeError('userId is required');
    }

    const logFilePath = await getLogFileName(userId, 'message');
    const cleanPhoneNumber = phoneNumber ? phoneNumber.replace('@c.us', '') : 'unknown';
    const date = new Date();

    const dateString = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}/${date.getFullYear()}`;
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let logLine = `${leadID || 'unknown'};${cleanPhoneNumber};${status};${dateString};${timeString}`;
    if (error.includes('invalid wid')) {
        logLine += " - WhatsApp account not found";
    } else if (error) {
        logLine += ` - Error detail: ${error}`;
    }
    logLine += `\n`;

    try {
        await fs.appendFile(logFilePath, logLine, 'utf8');
    } catch (err) {
        console.error(`Failed to write log to ${logFilePath}:`, err);
    }
};

// Log server events
const logServerEvent = async (level, message) => {
    const logFilePath = await getLogFileName('server', 'events');
    const date = new Date();
    const timeString = date.toISOString();

    const logLine = `[${timeString}] [${level.toUpperCase()}] - ${message}\n`;
    try {
        await fs.appendFile(logFilePath, logLine, 'utf8');
    } catch (err) {
        console.error(`Failed to write server event log to ${logFilePath}:`, err);
    }
};

// Log client-specific events
const logClientEvent = async (clientId, level, message) => {
    const logFilePath = await getLogFileName(clientId, 'client');
    const date = new Date();
    const timeString = date.toISOString();

    const logLine = `[${timeString}] [${level.toUpperCase()}] - ${message}\n`;
    try {
        await fs.appendFile(logFilePath, logLine, 'utf8');
    } catch (err) {
        console.error(`Failed to write client event log to ${logFilePath}:`, err);
    }
};

module.exports = {
    logMessageStatus,
    logServerEvent,
    logClientEvent
};
