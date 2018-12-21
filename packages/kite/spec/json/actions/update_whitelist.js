'use strict';

const {updateKitePaths} = require('kite-api/test/helpers/kite');
const {jsonPath} = require('../utils');

module.exports = (action) => {
  beforeEach(() => {
    updateKitePaths({
      whitelist: action.properties.whitelist.map(p => jsonPath(p)),
    });
  });
};
