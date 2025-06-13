const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const serverLogger = require('../../config/winstonLogger'); // Import the pre-configured server logger
const { LOGS_CLIENTS_DIR } = require('../../config/paths'); // Import client logs directory

const clientLoggers = {}; // Cache for client-specific loggers

// Define custom log levels (should match winstonLogger.js)
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    silly: 4
};

/**
 * Gets or creates Winston logger instances for a specific client ID, separated by type.
 * @param {string} clientId
 * @returns {{authLogger: winston.Logger, messageLogger: winston.Logger}}
 */
const getClientLogger = (clientId) => {
    if (clientLoggers[clientId]) {
        return clientLoggers[clientId];
    }

    const clientBaseLogsDir = path.join(LOGS_CLIENTS_DIR, clientId.toString());

    // --- Auth Logger Transports ---
    const authLogsDir = path.join(clientBaseLogsDir, 'Auth log');
    const authTransports = [
        new DailyRotateFile({
            filename: path.join(authLogsDir, '%DATE%', 'combined.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info'
        }),
        new DailyRotateFile({
            filename: path.join(authLogsDir, '%DATE%', 'error.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error'
        })
    ];

    const authLogger = winston.createLogger({
        levels: levels,
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.json()
        ),
        transports: authTransports
    });

    // --- Message Logger Transports ---
    const messagesLogsDir = path.join(clientBaseLogsDir, 'messages log');
    const messageTransports = [
        new DailyRotateFile({
            filename: path.join(messagesLogsDir, '%DATE%', 'combined.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info'
        }),
        new DailyRotateFile({
            filename: path.join(messagesLogsDir, '%DATE%', 'error.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error'
        })
    ];

    const messageLogger = winston.createLogger({
        levels: levels,
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.json()
        ),
        transports: messageTransports
    });

    clientLoggers[clientId] = { authLogger, messageLogger };
    return clientLoggers[clientId];
};


// Log the message status, phone number, status, error, and timestamp
const logMessageStatus = async (userId, phoneNumber, status, leadID, error = '') => {
    if (!userId) {
        serverLogger.error('logMessageStatus called without userId');
        return;
    }

    const { messageLogger } = getClientLogger(userId);
    const cleanPhoneNumber = phoneNumber ? phoneNumber.replace('@c.us', '') : 'unknown';

    let logDetails = {
        userId: userId,
        phoneNumber: cleanPhoneNumber,
        status: status,
        leadID: leadID || 'unknown',
    };

    // Only add the 'error' property if an error message is present
    if (error) {
        logDetails.error = error;
        if (error.includes('invalid wid')) {
            logDetails.detail = "WhatsApp account not found";
        } else {
            logDetails.detail = `Error detail: ${error}`;
        }
    }

    messageLogger.info(`Message status for ${cleanPhoneNumber}: ${status}`, logDetails);
};

// Log server events (uses the main server logger)
const logServerEvent = (level, message) => {
    const metadata = { context: 'server' };
    serverLogger.log(level, message, metadata);
};

// Log client-specific events (uses the client-specific logger)
const logClientEvent = (clientId, level, message) => {
    if (!clientId) {
        serverLogger.error('logClientEvent called without clientId');
        return;
    }
    const { authLogger } = getClientLogger(clientId);
    const metadata = { clientId: clientId, context: 'client' };
    authLogger.log(level, message, metadata);
};

module.exports = {
    logMessageStatus,
    logServerEvent,
    logClientEvent
};
