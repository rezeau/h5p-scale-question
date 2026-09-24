var H5PUpgrades = H5PUpgrades || {};

H5PUpgrades['H5P.ScaleQuestion'] = (function () {
  'use strict';

  return {
    0: {
      2: {
        contentUpgrade: function (parameters, finished) {
          // Thumbnail fields are optional, so existing 0.1 content needs no data changes.
          finished(null, parameters);
        }
      }
    }
  };
})();
