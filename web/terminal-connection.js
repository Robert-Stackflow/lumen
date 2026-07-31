(function (global) {
  'use strict';

  function websocketUrl(location, basePath, id, connectionKey, skipReplay, readOnly, privilegedGrant = '') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${basePath}/ws?arg=${encodeURIComponent(id)}`
      + `&arg=${encodeURIComponent(connectionKey)}&arg=${skipReplay ? '1' : '0'}`
      + `&arg=${readOnly ? '1' : '0'}`
      + (privilegedGrant ? `&arg=${encodeURIComponent(privilegedGrant)}` : '');
  }

  function reconnectDelay(attempt) {
    return Math.min(10000, 500 * (2 ** Math.min(Number(attempt) || 0, 5)));
  }

  global.LumenTerminalConnection = Object.freeze({ websocketUrl, reconnectDelay });
})(globalThis);
