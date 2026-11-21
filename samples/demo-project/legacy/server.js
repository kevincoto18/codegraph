const config = require('./config');

/** Starts the legacy HTTP server. */
function start() {
  return config.getConfig().port;
}

module.exports = start;
