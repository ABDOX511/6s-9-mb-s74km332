const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const { LOGS_SERVER_DIR } = require('./paths');

// Define custom log levels if necessary
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    silly: 4
};

// Define custom colors for console output (optional)
winston.addColors({
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
    silly: 'magenta'
});

// Configure transports
const transports = [
    new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                let log = `${timestamp} [${level}]: ${message}`;
                if (Object.keys(meta).length) {
                    log += ` ${JSON.stringify(meta)}`;
                }
                return log;
            })
        )
    }),
    // Combined server logs for all levels, organized by date folder
    new DailyRotateFile({
        filename: path.join(LOGS_SERVER_DIR, '%DATE%', 'combined.log'), // Date folder for server logs
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        level: 'info' // Log info and above to combined file
    }),
    // Error specific server logs, organized by date folder
    new DailyRotateFile({
        filename: path.join(LOGS_SERVER_DIR, '%DATE%', 'error.log'), // Date folder for server errors
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        level: 'error' // Log only errors to error file
    })
];

// Create the logger instance
const logger = winston.createLogger({
    levels: levels,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json() // Output logs as JSON
    ),
    transports: transports,
    exceptionHandlers: [
        new DailyRotateFile({
            filename: path.join(LOGS_SERVER_DIR, '%DATE%', 'exceptions.log'), // Date folder for server exceptions
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        })
    ],
    rejectionHandlers: [
        new DailyRotateFile({
            filename: path.join(LOGS_SERVER_DIR, '%DATE%', 'rejections.log'), // Date folder for server rejections
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        })
    ]
});

module.exports = logger; 