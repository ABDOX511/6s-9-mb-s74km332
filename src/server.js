require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const {VIEWS_DIR, UTILS_DIR} = require('./config/paths');
const { terminateAllClientsService } = require('./services/clientService');
const { logServerEvent } = require(path.join(UTILS_DIR, 'logUtils'));
const routes = require('./routes');
const app = express();
const PORT = process.env.PORT || 3000;


app.use(bodyParser.json());
app.use('/api', routes);

// Serve the admin page (with user ID input)
app.get('/indexar', (req, res) => {
  res.sendFile(`${VIEWS_DIR}/indexar.html`);
});

// Serve the user-specific QR page
app.get('/user/:userID([0-9]+)', (req, res) => {
  res.sendFile(`${VIEWS_DIR}/user-qr.html`);
});

app.use((err, req, res, next) => {
    logServerEvent('error', err.message, { stack: err.stack });
    if (res.headersSent) {
        // If headers have already been sent, delegate to the default Express error handler
        // which will close the connection if it hasn't already.
        return next(err);
    }
    res.status(500).send('Internal Server Error');
});

const gracefulShutdown = async (signal) => {
    logServerEvent('info', `Received ${signal}. Graceful shutdown initiated.`);
    try {
        await terminateAllClientsService();
        logServerEvent('info', 'All clients terminated successfully.');
        process.exit(0);
    } catch (error) {
        logServerEvent('error', `Error during graceful shutdown: ${error.message}`);
        process.exit(1);
    }
};

// Listen for termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

app.listen(PORT, () => {
    logServerEvent('info', `Server is running on http://localhost:${PORT}`);
    console.log(`Server is running on http://localhost:${PORT}`);
});