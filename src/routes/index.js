const router = require('express').Router();

router.use('/clients',  require('./clientRoutes'));
router.use('/messages', require('./messageRoutes'));

router.get('/zoho-widget', (req, res) => {
  res.sendFile('zoho-widget.html', { root: './public/views' });
});

router.use('/zoho', (req, res, next) => {
  console.log(`[index.js] Routing /zoho request. Original URL: ${req.originalUrl}, Base URL: ${req.baseUrl}, Path: ${req.path}`);
  require('./zohoRoutes')(req, res, next);
});

module.exports = router;
