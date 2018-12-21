'use strict';

const {updateKitePaths} = require('kite-api/test/helpers/kite');
const {jsonPath} = require('../utils');

module.exports = (action) => {
  beforeEach(() => {
    updateKitePaths({
      blacklist: action.properties.blacklist.map(p => jsonPath(p)),
    });
  });
};
