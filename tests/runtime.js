const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const context = { globalThis: {}, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync('web/runtime.js', 'utf8'), context);
const { preferencePatch } = context.globalThis.LumenRuntime;

assert.deepEqual(
  JSON.parse(JSON.stringify(preferencePatch({ theme: 'dark', size: 14 }, { theme: 'dark', size: 13 }))),
  { size: 14 },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(preferencePatch({ enabled: true }, null))),
  { enabled: true },
);
console.log('runtime preference diff checks passed');
