const fs = require('fs-extra'); // Changed to fs-extra for ensureDir
const path = require('path');
const redis = require('../config/redisClient'); // Import Redis client
const { logMessageStatus } = require('../utils/logUtils'); // Import logMessageStatus
const { LOGS_CLIENTS_DIR } = require('../config/paths'); // Import LOGS_CLIENTS_DIR
const { extractMediaPath } = require('../utils/mediaUtils'); // NEW: Import extractMediaPath

const receiveZohoData = async (req, res) => {
  try {
    const data = req.body;
    if (!data) {
      return res.status(400).json({ message: 'No data received' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dateFolder = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = `zoho_campaign_data_${timestamp}.json`; // More specific filename

    // Determine clientId for logging, default to 'unknown' if not present for some reason
    const clientIdForLog = data.user ? String(data.user) : 'unknown';

    // Construct the new file path: logs/clients/<clientId>/campaign/<YYYY-MM-DD>/zoho_campaign_data_...json
    const logDir = path.join(LOGS_CLIENTS_DIR, clientIdForLog, 'campaign', dateFolder);
    const filePath = path.join(logDir, filename);

    // Ensure the directory exists before writing the file
    await fs.ensureDir(logDir); // This will create the directories if they don't exist

    // Always save the raw incoming data for auditing/debugging purposes
    fs.writeFile(filePath, JSON.stringify(data, null, 2), async (err) => {
      if (err) {
        console.error(`Error writing Zoho campaign data to ${filePath}:`, err);
        return res.status(500).json({ message: 'Failed to save data' });
      }
      console.log(`Zoho campaign data saved to ${filePath}`);

      // Check if this data is intended for sending messages from the "zoho" module
      if (data.module_id === 'zoho' && data.user && data.leads && data.message) {
        const clientId = String(data.user);
        let messageText = String(data.message); // Make messageText mutable
        let mediaPath = null; // Initialize mediaPath

        // NEW: Extract media path from the message text
        const extracted = extractMediaPath(messageText);
        mediaPath = extracted.mediaPath;
        messageText = extracted.cleanMessage; // Use the cleaned message text

        const leads = data.leads;
        const queueKey = `whatsapp:queue:${clientId}`;
        let queuedCount = 0;

        try {
          for (const lead of leads) {
            const rawPhoneNumber = String(lead.phone);
            // Replicate phone number formatting from messageController.js
            const phoneNumber = rawPhoneNumber.replace(/^\+/, '').replace(/\D/g, '') + '@c.us';
            const leadID = String(lead.id);

            const messageData = {
              phoneNumber,
              message: messageText, // Use the potentially cleaned messageText
              mediaPath: mediaPath, // Use the extracted mediaPath
              userId: clientId,
              leadID: leadID
            };

            await redis.rpush(queueKey, JSON.stringify(messageData));
            logMessageStatus(clientId, phoneNumber, 'queued', leadID);
            queuedCount++;
          }
          console.log(`Successfully queued ${queuedCount} messages for client ${clientId} from Zoho.`);
          res.status(200).json({
            message: 'Data received and messages queued successfully',
            status: 'queued',
            queuedCount: queuedCount,
            clientId: clientId
          });
        } catch (queueError) {
          console.error('Error queuing Zoho messages:', queueError);
          // Still return 200 for initial data receipt, but indicate queuing failure
          res.status(200).json({
            message: 'Data received, but failed to queue all messages.',
            status: 'partial_failure',
            error: queueError.message
          });
        }
      } else {
        // If not a 'zoho' module request, or missing required fields, just confirm data saved
        res.status(200).json({ message: 'Data received and saved successfully' });
      }
    });
  } catch (error) {
    console.error('Error in receiveZohoData:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { receiveZohoData }; 