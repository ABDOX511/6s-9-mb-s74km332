const router = require('express').Router();
const wrap   = require('../middlewares/asyncWrapper');
const path = require('path');
const { CONTROLLERS_DIR } = require('../config/paths');
const clientController = require(path.join(CONTROLLERS_DIR, 'clientController'));

// POST /api/clients/add
router.post('/add',     wrap(clientController.addClient));
// POST /api/clients/end
router.post('/end',     wrap(clientController.terminateClients));
// POST /api/clients/terminate/:id
router.post('/terminate/:id', wrap(clientController.terminateClient));
// GET /api/clients/qr/:userID
router.get('/qr/:userID', wrap(clientController.getQrCode));
// GET /api/clients/qr-updates/:userID
router.get('/qr-updates/:userID', wrap(clientController.streamQrUpdates));

module.exports = router;
