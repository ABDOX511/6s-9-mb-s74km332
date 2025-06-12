const router = require('express').Router();
const wrap   = require('../middlewares/asyncWrapper');
const messageController = require('../controllers/messageController');

// POST /api/messages
router.post('/', wrap(messageController.sendMessage));

module.exports = router;
