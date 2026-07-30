(function exposeLumenSelection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LumenSelection = api;
  }
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const PRESENTATION_GUTTER_COLUMNS = 2;

  function leadingSpaces(line) {
    let count = 0;
    while (line[count] === ' ') count += 1;
    return count;
  }

  function normalizeTerminalSelection(text, context = {}) {
    const lines = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.trimEnd());
    const contentLines = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].length > 0) {
        contentLines.push({
          index,
          indent: leadingSpaces(lines[index]),
        });
      }
    }

    if (contentLines.length >= 2) {
      const firstLineIsPartial = Boolean(
        context.startsOnWrappedRow
        || context.startColumn > 0,
      );
      const completeLines = firstLineIsPartial
        ? contentLines.slice(1)
        : contentLines;

      if (
        completeLines.length > 0
        && completeLines.every(line => line.indent >= PRESENTATION_GUTTER_COLUMNS)
      ) {
        for (const line of completeLines) {
          lines[line.index] = lines[line.index].slice(PRESENTATION_GUTTER_COLUMNS);
        }
        if (firstLineIsPartial && !context.startsOnWrappedRow) {
          const first = contentLines[0];
          const selectedGutterColumns = Math.max(
            0,
            PRESENTATION_GUTTER_COLUMNS - context.startColumn,
          );
          lines[first.index] = lines[first.index].slice(
            Math.min(first.indent, selectedGutterColumns),
          );
        }
      } else if (!firstLineIsPartial) {
        const first = contentLines[0];
        const laterLineStartsAtColumnZero = contentLines
          .slice(1)
          .some(line => line.indent === 0);
        if (first.indent === PRESENTATION_GUTTER_COLUMNS && laterLineStartsAtColumnZero) {
          lines[first.index] = lines[first.index].slice(PRESENTATION_GUTTER_COLUMNS);
        }
      }
    }

    return lines.join('\n');
  }

  function normalizeSelectionFromTerminal(term) {
    const position = term.getSelectionPosition();
    if (!position) return '';

    let start = position.start;
    const end = position.end;
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
      start = end;
    }
    return normalizeTerminalSelection(term.getSelection(), {
      startColumn: start.x,
      startsOnWrappedRow: Boolean(term.buffer.active.getLine(start.y)?.isWrapped),
    });
  }

  function cellIsBlank(line, column) {
    const cell = line?.getCell(column);
    if (!cell) return true;

    // A zero-width cell is the second half of a wide glyph. Treating it as
    // blank would visually cut CJK characters and emoji in half.
    if (cell.getWidth() === 0) return false;
    const chars = cell.getChars();
    return chars.length === 0 || /^\s+$/u.test(chars);
  }

  function selectionRows(term) {
    const position = term.getSelectionPosition();
    if (!position) return [];

    let start = position.start;
    let end = position.end;
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
      [start, end] = [end, start];
    }

    const buffer = term.buffer.active;
    const rows = [];
    const lastBufferRow = buffer.length - 1;
    const firstRow = Math.max(0, Math.min(start.y, lastBufferRow));
    const lastRow = Math.max(0, Math.min(end.y, lastBufferRow));

    for (let row = firstRow; row <= lastRow; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;

      let from = row === start.y ? start.x : 0;
      let to = row === end.y ? end.x : term.cols;
      from = Math.max(0, Math.min(from, term.cols));
      to = Math.max(0, Math.min(to, term.cols));

      // Expand a range that happens to land inside a wide character so the
      // custom highlight always covers the complete terminal glyph.
      if (from > 0 && line.getCell(from)?.getWidth() === 0) from -= 1;
      if (to < term.cols && line.getCell(to)?.getWidth() === 0) to += 1;

      if (to > from) rows.push({ row, from, to, line });
    }
    return rows;
  }

  function rowHasContent(row) {
    for (let column = row.from; column < row.to; column += 1) {
      if (!cellIsBlank(row.line, column)) return true;
    }
    return false;
  }

  function leadingBlankCells(row) {
    let column = row.from;
    while (column < row.to && cellIsBlank(row.line, column)) column += 1;
    return column - row.from;
  }

  function computeTerminalSelectionRanges(term) {
    const rows = selectionRows(term);
    if (rows.length === 0) return [];

    // A wrapped terminal row continues the previous logical line. Only trim
    // at real line endings or at the actual end of the user's selection.
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const next = rows[index + 1];
      const continuesOnNextRow = Boolean(
        next
        && next.row === row.row + 1
        && next.line.isWrapped,
      );
      if (!continuesOnNextRow) {
        while (row.to > row.from && cellIsBlank(row.line, row.to - 1)) {
          row.to -= 1;
        }
      }
    }

    const groups = [];
    let group = null;
    for (const row of rows) {
      if (!group || row.row !== group.rows[group.rows.length - 1].row + 1 || !row.line.isWrapped) {
        group = { rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
    }

    const contentGroups = groups
      .map(candidate => {
        const first = candidate.rows[0];
        return {
          ...candidate,
          first,
          indent: leadingBlankCells(first),
          hasContent: candidate.rows.some(rowHasContent),
        };
      })
      .filter(candidate => candidate.hasContent);

    if (contentGroups.length >= 2) {
      const first = contentGroups[0];
      const firstLineIsPartial = first.first.from > 0 || first.first.line.isWrapped;
      const completeGroups = firstLineIsPartial
        ? contentGroups.slice(1)
        : contentGroups;

      if (
        completeGroups.length > 0
        && completeGroups.every(candidate => candidate.indent >= PRESENTATION_GUTTER_COLUMNS)
      ) {
        for (const candidate of completeGroups) {
          candidate.first.from += PRESENTATION_GUTTER_COLUMNS;
        }
        if (firstLineIsPartial && !first.first.line.isWrapped) {
          const selectedGutterColumns = Math.max(
            0,
            PRESENTATION_GUTTER_COLUMNS - first.first.from,
          );
          first.first.from += Math.min(first.indent, selectedGutterColumns);
        }
      } else if (!firstLineIsPartial) {
        const laterLineStartsAtColumnZero = contentGroups
          .slice(1)
          .some(candidate => candidate.indent === 0);
        if (first.indent === PRESENTATION_GUTTER_COLUMNS && laterLineStartsAtColumnZero) {
          first.first.from += PRESENTATION_GUTTER_COLUMNS;
        }
      }
    }

    return rows
      .filter(row => row.to > row.from)
      .map(row => ({
        row: row.row,
        start: row.from,
        end: row.to,
      }));
  }

  return Object.freeze({
    computeTerminalSelectionRanges,
    normalizeSelectionFromTerminal,
    normalizeTerminalSelection,
  });
});
