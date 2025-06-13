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
<<<<<<< HEAD
 * Gets or creates Winston logger instances for a specific client ID, separated by type.
 * @param {string} clientId
 * @returns {{authLogger: winston.Logger, messageLogger: winston.Logger}}
=======
 * Gets or creates a Winston logger instance for a specific client ID.
 * @param {string} clientId
 * @returns {winston.Logger}
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
 */
const getClientLogger = (clientId) => {
    if (clientLoggers[clientId]) {
        return clientLoggers[clientId];
    }

<<<<<<< HEAD
    const clientBaseLogsDir = path.join(LOGS_CLIENTS_DIR, clientId.toString());

    // --- Auth Logger Transports ---
    const authLogsDir = path.join(clientBaseLogsDir, 'Auth log');
    const authTransports = [
        new DailyRotateFile({
            filename: path.join(authLogsDir, '%DATE%', 'combined.log'),
=======
    const clientLogsDir = path.join(LOGS_CLIENTS_DIR, clientId.toString());

    const clientTransports = [
        // Client combined logs
        new DailyRotateFile({
            filename: path.join(clientLogsDir, '%DATE%', 'combined.log'),
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info'
        }),
<<<<<<< HEAD
        new DailyRotateFile({
            filename: path.join(authLogsDir, '%DATE%', 'error.log'),
=======
        // Client error specific logs
        new DailyRotateFile({
            filename: path.join(clientLogsDir, '%DATE%', 'error.log'),
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error'
        })
    ];

<<<<<<< HEAD
    const authLogger = winston.createLogger({
=======
    const clientLogger = winston.createLogger({
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
        levels: levels,
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.json()
        ),
<<<<<<< HEAD
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
=======
        transports: clientTransports
    });

    clientLoggers[clientId] = clientLogger;
    return clientLogger;
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
};


// Log the message status, phone number, status, error, and timestamp
const logMessageStatus = async (userId, phoneNumber, status, leadID, error = '') => {
    if (!userId) {
        serverLogger.error('logMessageStatus called without userId');
        return;
    }

<<<<<<< HEAD
    const { messageLogger } = getClientLogger(userId);
=======
    const clientLogger = getClientLogger(userId);
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
    const cleanPhoneNumber = phoneNumber ? phoneNumber.replace('@c.us', '') : 'unknown';

    let logDetails = {
        userId: userId,
        phoneNumber: cleanPhoneNumber,
        status: status,
        leadID: leadID || 'unknown',
<<<<<<< HEAD
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
=======
        error: error
    };

    if (error.includes('invalid wid')) {
        logDetails.detail = "WhatsApp account not found";
    } else if (error) {
        logDetails.detail = `Error detail: ${error}`;
    }

    clientLogger.info(`Message status for ${cleanPhoneNumber}: ${status}`, logDetails);
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
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
<<<<<<< HEAD
    const { authLogger } = getClientLogger(clientId);
    const metadata = { clientId: clientId, context: 'client' };
    authLogger.log(level, message, metadata);
=======
    const clientLogger = getClientLogger(clientId);
    const metadata = { clientId: clientId, context: 'client' };
    clientLogger.log(level, message, metadata);
>>>>>>> f71e7e9454e192a438134d4d169729812f473c95
};

module.exports = {
    logMessageStatus,
    logServerEvent,
    logClientEvent
};
