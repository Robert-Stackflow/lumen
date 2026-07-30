const assert = require('node:assert/strict');
const {
  formatDateTime,
  formatDuration,
  isCurrentConnection,
} = require('../web/session-manager.js');

assert.equal(formatDuration(0), '0 秒');
assert.equal(formatDuration(61_000), '1 分钟');
assert.equal(formatDuration(3_661_000), '1 小时 1 分钟');
assert.equal(formatDuration(90_000_000), '1 天 1 小时');
assert.equal(formatDuration(-1), '未知');
assert.equal(formatDateTime(0), '未知');
assert.equal(isCurrentConnection({ connectionKey: 'a' }, { browserKey: 'a' }), true);
assert.equal(isCurrentConnection({ connectionKey: 'a' }, { browserKey: 'b' }), false);
console.log('session manager formatting and identity checks passed');
