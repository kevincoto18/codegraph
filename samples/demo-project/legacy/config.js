const path = require('path');
const { loadDefaults } = require('./defaults');

/** Builds the runtime configuration. */
function getConfig() {
  return { ...loadDefaults(), root: path.resolve('.') };
}

module.exports = { getConfig };
