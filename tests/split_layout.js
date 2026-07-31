const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync('web/split-layout.js', 'utf8'), context);
const Layout = context.globalThis.LumenSplitLayout;
const layout = new Layout();
assert.equal(layout.open('one', 'two', 'horizontal'), true);
assert.equal(layout.contains('two'), true);
assert.equal(layout.resize(0.9), 0.75);
assert.equal(JSON.parse(JSON.stringify(layout.serialize())).direction, 'horizontal');
layout.close();
assert.equal(layout.active, false);
console.log('split layout state checks passed');
