const os = require('os'); // Node.js built-in module for operating system-related utility functions
const { logServerEvent } = require('../utils/logUtils');
const { terminateClient, getAllClients } = require('./clientService'); // Import getAllClients

class MemoryMonitor {
    constructor(thresholdPercent = 85, actionCooldownMs = 300000) { // 5-minute cooldown
        this.thresholdPercent = thresholdPercent;
        this.actionCooldownMs = actionCooldownMs;
        this.interval = null;
        this.lastActionTimestamp = 0; // To track when the last action was taken
    }

    start(checkIntervalMs = 60000) {
        if (this.interval) {
            logServerEvent('warn', 'MemoryMonitor is already running. Skipping start.');
            return;
        }
        logServerEvent('info', `MemoryMonitor started with threshold: ${this.thresholdPercent}% and action cooldown: ${this.actionCooldownMs / 1000}s`);
        this.interval = setInterval(() => this.checkMemoryUsage(), checkIntervalMs);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            logServerEvent('info', 'MemoryMonitor stopped.');
        }
    }

    checkMemoryUsage() {
        const memoryUsage = process.memoryUsage(); // Memory usage of the Node.js process
        const totalSystemMemory = os.totalmem();   // Total system memory
        
        // Calculate the percentage of total system RAM used by the process
        const usedMemoryPercent = (memoryUsage.rss / totalSystemMemory) * 100;
        
        logServerEvent('info', `Memory usage: ${usedMemoryPercent.toFixed(2)}% (RSS: ${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap Total: ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB, Heap Used: ${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB)`);
        
        if (usedMemoryPercent > this.thresholdPercent) {
            this.handleHighMemoryUsage(usedMemoryPercent);
        }
    }

    async handleHighMemoryUsage(usedPercent) {
        const now = Date.now();
        if (now - this.lastActionTimestamp < this.actionCooldownMs) {
            logServerEvent('info', `High memory detected (${usedPercent.toFixed(2)}%), but cooldown is active. Skipping client termination.`);
            return;
        }

        logServerEvent('warn', `High memory usage detected: ${usedPercent.toFixed(2)}% of total system memory. Attempting to free memory by terminating non-active clients.`);
        
        this.lastActionTimestamp = now; // Update last action timestamp

        const clients = getAllClients();
        let terminatedCount = 0;
        const terminationPromises = [];

        for (const clientId in clients) {
            const clientEntry = clients[clientId];
            // If client is not active or ready, it's a candidate for termination to free memory
            if (clientEntry && !clientEntry.isActive && !clientEntry.isReady) {
                logServerEvent('info', `Memory optimization: Terminating client ${clientId} (status: not active/ready) to free resources.`);
                terminationPromises.push(terminateClient(clientId).then(() => {
                    terminatedCount++;
                }).catch(err => {
                    logServerEvent('error', `Failed to terminate client ${clientId} during memory optimization: ${err.message}`);
                }));
            }
        }

        if (terminationPromises.length > 0) {
            await Promise.allSettled(terminationPromises); // Wait for all terminations to attempt
            logServerEvent('info', `Memory optimization completed. Terminated ${terminatedCount} non-active/ready clients.`);
        } else {
            logServerEvent('info', `Memory optimization attempted, but no non-active/ready clients found to terminate.`);
        }
    }
}

module.exports = new MemoryMonitor();