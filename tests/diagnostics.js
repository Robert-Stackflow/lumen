const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const events = {};
const stored = new Map();
const context = {
  globalThis: {
    addEventListener(name, listener) { events[name] = listener; },
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, value); },
      removeItem(key) { stored.delete(key); },
    },
  },
};
vm.runInNewContext(fs.readFileSync('web/diagnostics.js', 'utf8'), context);
const diagnostics = context.globalThis.LumenDiagnostics;
diagnostics.report('WebSocket', new Error('closed'));
diagnostics.report('WebSocket', new Error('closed'));
diagnostics.report('IndexedDB', 'quota');
diagnostics.report('偏好同步', 'conflict');
assert.equal(diagnostics.filter('websocket').length, 1);
assert.equal(diagnostics.filter('websocket')[0].count, 2);
assert.equal(diagnostics.filter('indexeddb').length, 1);
assert.equal(diagnostics.filter('preferences').length, 1);
assert.match(diagnostics.serialize('websocket'), /closed/);
assert.match(stored.get('lumen.diagnostics.v1'), /closed/);
diagnostics.clear();
assert.equal(diagnostics.list().length, 0);
console.log('diagnostic filtering and export checks passed');
