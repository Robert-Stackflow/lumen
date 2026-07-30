'use strict';

const assert = require('node:assert/strict');
const {
  computeTerminalSelectionRanges,
  normalizeSelectionFromTerminal,
  normalizeTerminalSelection,
} = require('../web/selection.js');

assert.equal(
  normalizeTerminalSelection('foo  \r\nbar\t\u00a0\r\n'),
  'foo\nbar\n',
  'line endings and every form of trailing whitespace should be normalized',
);
assert.equal(
  normalizeTerminalSelection('  one  \n    child \n  three\t'),
  'one\n  child\nthree',
  'a common two-column presentation gutter should be removed',
);
assert.equal(
  normalizeTerminalSelection('  first\nsecond\n  semantic'),
  'first\nsecond\n  semantic',
  'a two-column selection overhang should only be removed from the first line',
);
assert.equal(
  normalizeTerminalSelection('  single indented line  '),
  '  single indented line',
  'single-line semantic indentation should be preserved',
);
assert.equal(
  normalizeTerminalSelection('    nested\nroot'),
  '    nested\nroot',
  'mixed semantic indentation should be preserved',
);
assert.equal(
  normalizeTerminalSelection('first\n  second\n  third', { startColumn: 2 }),
  'first\nsecond\nthird',
  'complete lines should lose their gutter when the first selection line starts at its content',
);
assert.equal(
  normalizeTerminalSelection(' first\n  second\n  third', { startColumn: 1 }),
  'first\nsecond\nthird',
  'the selected remainder of the first-line gutter should also be removed',
);

function cells(text, columns) {
  return Array.from({ length: columns }, (_, index) => ({
    getChars: () => text[index] || '',
    getWidth: () => 1,
  }));
}

function fakeLine(text, columns, isWrapped = false, customCells = null) {
  const lineCells = customCells || cells(text, columns);
  return {
    isWrapped,
    getCell: column => lineCells[column],
  };
}

function fakeTerm(lines, position, columns = 8) {
  return {
    cols: columns,
    getSelectionPosition: () => position,
    getSelection: () => '',
    buffer: {
      active: {
        length: lines.length,
        getLine: row => lines[row],
      },
    },
  };
}

const partialFirstLineTerm = fakeTerm(
  [
    fakeLine('  foo   ', 8),
    fakeLine('  bar   ', 8),
  ],
  { start: { x: 2, y: 0 }, end: { x: 8, y: 1 } },
);
partialFirstLineTerm.getSelection = () => 'foo\n  bar';
assert.equal(
  normalizeSelectionFromTerminal(partialFirstLineTerm),
  'foo\nbar',
  'terminal-aware text cleanup should recognize a partial first line',
);
assert.deepEqual(
  computeTerminalSelectionRanges(partialFirstLineTerm),
  [
    { row: 0, start: 2, end: 5 },
    { row: 1, start: 2, end: 5 },
  ],
  'visual ranges should recognize a partial first line and trim later gutters',
);

assert.deepEqual(
  computeTerminalSelectionRanges(fakeTerm(
    [
      fakeLine('  foo   ', 8),
      fakeLine('  bar   ', 8),
    ],
    { start: { x: 0, y: 0 }, end: { x: 8, y: 1 } },
  )),
  [
    { row: 0, start: 2, end: 5 },
    { row: 1, start: 2, end: 5 },
  ],
  'visual ranges should remove a common gutter and trailing cells',
);

assert.deepEqual(
  computeTerminalSelectionRanges(fakeTerm(
    [
      fakeLine('word    ', 8),
      fakeLine('next    ', 8, true),
      fakeLine('done    ', 8),
    ],
    { start: { x: 0, y: 0 }, end: { x: 8, y: 2 } },
  )),
  [
    { row: 0, start: 0, end: 8 },
    { row: 1, start: 0, end: 4 },
    { row: 2, start: 0, end: 4 },
  ],
  'soft-wrapped rows should only be trimmed at their logical line ending',
);

const wideCells = [
  { getChars: () => '你', getWidth: () => 2 },
  { getChars: () => '', getWidth: () => 0 },
  { getChars: () => ' ', getWidth: () => 1 },
  { getChars: () => '', getWidth: () => 1 },
];
assert.deepEqual(
  computeTerminalSelectionRanges(fakeTerm(
    [fakeLine('', 4, false, wideCells)],
    { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    4,
  )),
  [{ row: 0, start: 0, end: 2 }],
  'wide glyph continuation cells should remain highlighted',
);

console.log('selection normalization and visual range checks passed');
