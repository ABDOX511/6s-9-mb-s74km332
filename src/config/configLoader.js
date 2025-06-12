const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./paths');

let config = require('./delays');

const configPath = path.join(CONFIG_DIR, 'delays.js');

const loadConfig = () => {
    try {
        delete require.cache[require.resolve(configPath)];
        config = require(configPath);
        console.log('Configuration loaded:', config);
    } catch (error) {
        console.error('Error loading configuration:', error.message);
    }
};

const watchConfig = () => {
    fs.watch(configPath, (eventType, filename) => {
        if (eventType === 'change') {
            console.log(`Configuration file changed. Reloading...`);
            loadConfig();
        }
    });
};

watchConfig();

const getConfig = () => config;

module.exports = {
    getConfig
}; 