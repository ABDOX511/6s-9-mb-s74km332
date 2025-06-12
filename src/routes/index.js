const router = require('express').Router();

router.use('/clients',  require('./clientRoutes'));
router.use('/messages', require('./messageRoutes'));

module.exports = router;
