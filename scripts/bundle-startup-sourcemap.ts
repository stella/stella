// Sourcemap attribution for built client chunks.
//
// A chunk's gzip size says how much a cold visit pays, not what it pays for:
// the startup chunk carries the route tree, every route file and whatever
// those import. The chunk's own sourcemap answers that. Every mapping segment
// covers the generated columns up to the next segment on its line, so summing
// those spans per original source gives each module's share of the minified
// chunk. Columns are UTF-16 code units, as the sourcemap format defines them;
// for minified JavaScript that is the byte count to within a few non-ASCII
// string literals.

import { panic } from "better-result";

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) {
  BASE64_VALUE[BASE64.codePointAt(index) ?? 0] = index;
}
// A digit at or above this value has a continuation digit after it.
const VLQ_CONTINUE = 32;

/** The subset of a version 3 sourcemap this reads. */
export type SourceMapV3 = {
  sources: readonly string[];
  mappings: string;
};

/**
 * One decoded line: segment start columns, the source index each starts (-1
 * where a segment maps to no source) and the 0-based original line.
 */
type DecodedLine = { columns: number[]; sources: number[]; lines: number[] };

export type ChunkAttribution = {
  /** Generated code units attributed to each source index. */
  bytesBySource: Float64Array;
  /**
   * For the sources asked for, generated code units per 0-based original
   * line.
   */
  bytesByLine: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /** The source index mapped at a generated position, or -1. */
  sourceAt: (line: number, column: number) => number;
};

const decodeLines = (mappings: string): DecodedLine[] => {
  const lines: DecodedLine[] = [];
  let source = 0;
  let originalLine = 0;
  let current: DecodedLine = { columns: [], sources: [], lines: [] };
  let column = 0;
  let position = 0;
  while (position <= mappings.length) {
    const char = mappings[position];
    if (char === undefined || char === ";") {
      lines.push(current);
      current = { columns: [], sources: [], lines: [] };
      column = 0;
      position += 1;
      continue;
    }
    if (char === ",") {
      position += 1;
      continue;
    }
    const fields: number[] = [];
    while (
      position < mappings.length &&
      mappings[position] !== "," &&
      mappings[position] !== ";"
    ) {
      // Base64 VLQ: five value bits per digit, least significant first, the
      // sixth bit set on every digit but the last; the lowest value bit is
      // the sign. Arithmetic rather than bit operations, as the lint rules
      // ask; every value stays far below 2^53.
      let value = 0;
      let scale = 1;
      let digit: number;
      do {
        digit = BASE64_VALUE[mappings.codePointAt(position) ?? 0] ?? -1;
        if (digit < 0) {
          panic(`Invalid sourcemap mappings character at ${position}`);
        }
        position += 1;
        value += (digit % VLQ_CONTINUE) * scale;
        scale *= VLQ_CONTINUE;
      } while (digit >= VLQ_CONTINUE);
      const magnitude = Math.floor(value / 2);
      fields.push(value % 2 === 1 ? -magnitude : magnitude);
    }
    column += fields[0] ?? 0;
    let mapped = -1;
    if (fields.length >= 4) {
      source += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      mapped = source;
    }
    current.columns.push(column);
    current.sources.push(mapped);
    current.lines.push(originalLine);
  }
  return lines;
};

/**
 * Attributes every generated code unit of `code` to the source mapped there,
 * and, for the source indexes in `lineSources`, to the original line.
 */
export const attributeChunk = (
  code: string,
  map: SourceMapV3,
  lineSources: ReadonlySet<number> = new Set(),
): ChunkAttribution => {
  const codeLines = code.split("\n");
  const decoded = decodeLines(map.mappings);
  const bytesBySource = new Float64Array(map.sources.length);
  const bytesByLine = new Map<number, Map<number, number>>();
  for (let line = 0; line < codeLines.length; line += 1) {
    const segments = decoded[line];
    if (segments === undefined) {
      break;
    }
    const length = codeLines[line]?.length ?? 0;
    for (let index = 0; index < segments.columns.length; index += 1) {
      const source = segments.sources[index] ?? -1;
      if (source < 0) {
        continue;
      }
      const start = segments.columns[index] ?? 0;
      const span = (segments.columns[index + 1] ?? length) - start;
      bytesBySource[source] = (bytesBySource[source] ?? 0) + span;
      if (lineSources.has(source)) {
        const perLine = bytesByLine.get(source) ?? new Map<number, number>();
        const original = segments.lines[index] ?? 0;
        perLine.set(original, (perLine.get(original) ?? 0) + span);
        bytesByLine.set(source, perLine);
      }
    }
  }
  const sourceAt = (line: number, column: number): number => {
    const segments = decoded[line];
    if (segments === undefined) {
      return -1;
    }
    // Minified chunks are a few very long lines: search, do not scan.
    let low = 0;
    let high = segments.columns.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((segments.columns[middle] ?? 0) <= column) {
        found = segments.sources[middle] ?? -1;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  };
  return { bytesBySource, bytesByLine, sourceAt };
};
