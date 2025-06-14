const router = require('express').Router();
const asyncWrapper   = require('../middlewares/asyncWrapper');
const path = require('path');
const { CONTROLLERS_DIR } = require('../config/paths');
const clientController = require(path.join(CONTROLLERS_DIR, 'clientController'));

// POST /api/clients/add
router.post('/add',     asyncWrapper(clientController.addClient));
// POST /api/clients/end
router.post('/end',     asyncWrapper(clientController.terminateClients));
// POST /api/clients/terminate/:id
router.post('/terminate/:id', asyncWrapper(clientController.terminateClient));
// GET /api/clients/qr-updates/:userID
router.get('/qr-updates/:userID', asyncWrapper(clientController.streamQrUpdates));

module.exports = router;
