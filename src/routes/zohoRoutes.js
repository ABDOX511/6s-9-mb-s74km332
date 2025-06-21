const express = require('express');
const router = express.Router();
const { receiveZohoData } = require('../controllers/zohoController');

router.post('/campaigns', (req, res, next) => {
  console.log(`[zohoRoutes.js] POST /campaigns reached. Path: ${req.path}`);
  receiveZohoData(req, res, next);
});
router.post('/campaigns/', (req, res, next) => {
  console.log(`[zohoRoutes.js] POST /campaigns/ reached. Path: ${req.path}`);
  receiveZohoData(req, res, next);
});

module.exports = router; 