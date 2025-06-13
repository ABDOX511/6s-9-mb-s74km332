const path = require('path');

// project root: two folders up from /src/config
const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  ROOT,
  DATA_AUTH : path.join(ROOT, 'data', '.wwebjs_auth'),
  DATA_CACHE: path.join(ROOT, 'data', '.wwebjs_cache'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  VIEWS_DIR : path.join(ROOT, 'public', 'views'),
  LOGS_DIR  : path.join(ROOT, 'logs'),
  LOGS_SERVER_DIR : path.join(ROOT, 'logs', 'server'),
  LOGS_CLIENTS_DIR : path.join(ROOT, 'logs', 'clients'),
  SERVICES_DIR : path.join(ROOT, 'src', 'services'),
  CONTROLLERS_DIR : path.join(ROOT, 'src', 'controllers'),
  UTILS_DIR : path.join(ROOT, 'src', 'utils'),
  CONFIG_DIR : path.join(ROOT, 'src', 'config'),
  ROUTES_DIR : path.join(ROOT, 'src', 'routes')
};
