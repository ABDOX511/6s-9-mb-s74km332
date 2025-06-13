const Redis = require('ioredis');
const { logServerEvent } = require('./logUtils'); // Using new logger
const redisClient = require('../config/redisClient'); // Re-using existing Redis client
const defaultDelays = require('../config/delays'); // Default values

const CONFIG_REDIS_KEY = 'whatsapp:config:delays';
const CONFIG_PUB_SUB_CHANNEL = 'whatsapp:config:updates';

let currentConfig = { ...defaultDelays }; // Initialize with defaults
let redisSubscriber; // Dedicated subscriber client for Pub/Sub

/**
 * Loads the configuration from Redis, or uses defaults if not found.
 * @returns {Promise<void>}
 */
const loadConfigFromRedis = async () => {
    try {
        const configData = await redisClient.hgetall(CONFIG_REDIS_KEY);

        if (Object.keys(configData).length === 0) {
            logServerEvent('info', 'No existing configuration found in Redis. Populating with defaults.');
            // Populate Redis with default values if empty
            await redisClient.hmset(CONFIG_REDIS_KEY, defaultDelays);
            currentConfig = { ...defaultDelays };
        } else {
            // Convert string values from Redis back to numbers
            const loadedConfig = {};
            for (const key in configData) {
                loadedConfig[key] = parseInt(configData[key], 10);
            }
            currentConfig = { ...defaultDelays, ...loadedConfig }; // Merge with defaults to ensure all keys exist
        }
    } catch (error) {
        logServerEvent('error', `Failed to load configuration from Redis: ${error.message}. Using default values.`);
        currentConfig = { ...defaultDelays };
    }
};

/**
 * Initializes the configuration manager: loads initial config and sets up Pub/Sub.
 */
const initConfigManager = async () => {
    await loadConfigFromRedis(); // Load initial config

    // Create a dedicated subscriber client for Pub/Sub
    // This is important because a client used for Pub/Sub cannot be used for regular commands.
    redisSubscriber = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1', // Ensure same connection details
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });

    redisSubscriber.on('error', (error) => {
        logServerEvent('error', `Redis subscriber error: ${error.message}`);
    });

    redisSubscriber.on('connect', () => {
        logServerEvent('info', 'Redis subscriber connected.');
        redisSubscriber.subscribe(CONFIG_PUB_SUB_CHANNEL, (err, count) => {
            if (err) {
                logServerEvent('error', `Failed to subscribe to Redis config channel: ${err.message}`);
            } else {
                logServerEvent('info', `Subscribed to ${count} Redis config channel: ${CONFIG_PUB_SUB_CHANNEL}`);
            }
        });
    });

    redisSubscriber.on('message', async (channel, message) => {
        if (channel === CONFIG_PUB_SUB_CHANNEL && message === 'delays_updated') {
            logServerEvent('info', 'Received config update notification. Reloading configuration from Redis.');
            await loadConfigFromRedis(); // Ensure config is reloaded before proceeding
        }
    });

    // Handle process exit to close Redis connection
    process.on('SIGINT', async () => {
        if (redisSubscriber) {
            logServerEvent('info', 'Closing Redis subscriber connection...');
            await redisSubscriber.quit();
        }
    });
};

/**
 * Returns the currently active configuration.
 * @returns {object} The current configuration object.
 */
const getConfig = () => {
    return { ...currentConfig }; // Return a shallow copy to prevent external modification
};

// Initialize the config manager as soon as this module is loaded
initConfigManager();

module.exports = {
    getConfig
}; 