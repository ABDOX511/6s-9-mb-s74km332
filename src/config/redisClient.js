const Redis = require('ioredis');
const { logServerEvent } = require('../utils/logUtils');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1'; // Your WSL IP
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;

const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null, // Unlimited retries for robustness
    enableReadyCheck: true,
    reconnectOnError: function (err) {
        const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'];
        if (targetErrors.some(targetError => err.message.includes(targetError))) {
            logServerEvent('warn', `Redis connection error: ${err.message}. Attempting to reconnect...`);
            return true; // Reconnect
        }
        logServerEvent('error', `Redis unrecoverable error: ${err.message}`);
        return false; // Do not reconnect on other errors
    }
});

redis.on('connect', () => {
    logServerEvent('info', 'Redis client connected to the server');
});

redis.on('error', (error) => {
    logServerEvent('error', `Redis client error: ${error.message}`);
});

module.exports = redis; 