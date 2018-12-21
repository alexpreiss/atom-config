'use strict';

const {updateKitePaths} = require('kite-api/test/helpers/kite');
const {jsonPath} = require('../utils');

module.exports = (action) => {
  beforeEach(() => {
    updateKitePaths({
      ignored: action.properties.ignored.map(p => jsonPath(p)),
    });
  });
};
