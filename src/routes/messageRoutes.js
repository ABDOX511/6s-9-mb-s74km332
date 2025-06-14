const router = require('express').Router();
const asyncWrapper   = require('../middlewares/asyncWrapper');
const messageController = require('../controllers/messageController');

// POST /api/messages
router.post('/', asyncWrapper(messageController.sendMessage));

module.exports = router;
