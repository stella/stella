/**
 * One row of stamp text, set: the Unicode Bidirectional Algorithm splits it
 * into runs that each read one way, the fallback chain splits those by
 * face, each run is shaped, and the runs are put in visual order.
 *
 * Positions are in thousandths of the font size, so one layout serves every
 * font size the stamp tries.
 */

import { panic } from "better-result";

import {
  BIDI_DIRECTION,
  SHAPING_DIRECTION,
} from "@stll/folio-core/text-shaping";

import type { PdfSigningStamp } from "@/api/db/schema";
import type {
  StampFace,
  StampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import { assignFaces } from "@/api/lib/files/pdf-signing/stamp-text";

/** Units per em of every position below. */
export const STAMP_UNITS_PER_EM = 1000;

/**
 * Characters that steer the bidirectional algorithm and are then gone:
 * the explicit embeddings, overrides and isolates, and the directional
 * marks. They take part in resolving levels and are never shaped.
 */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Isolates a value inserted into a label, in whichever direction it reads. */
export const FIRST_STRONG_ISOLATE = "\u2068";
/** Isolates a value that always reads left to right, such as a timestamp. */
export const LEFT_TO_RIGHT_ISOLATE = "\u2066";
export const POP_DIRECTIONAL_ISOLATE = "\u2069";

export type StampGlyph = {
  glyphId: number;
  /** UTF-8 byte offset into the run's text, as the shaper reports it. */
  cluster: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
};

export type StampRun = {
  face: StampFace;
  /** Glyphs in visual order, left to right. */
  glyphs: readonly StampGlyph[];
  /** The text each cluster stands for, by cluster offset. */
  clusterText: ReadonlyMap<number, string>;
};

export type StampRow = {
  /** Runs in visual order, left to right. */
  runs: readonly StampRun[];
  width: number;
};

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Each cluster's text: from its offset to the next cluster's. */
const clusterTexts = (text: string, glyphs: readonly StampGlyph[]) => {
  const bytes = utf8.encode(text);
  const starts = [...new Set(glyphs.map(({ cluster }) => cluster))].toSorted(
    (a, b) => a - b,
  );
  return new Map(
    starts.map((start, index) => [
      start,
      utf8Decoder.decode(
        bytes.subarray(start, starts[index + 1] ?? bytes.length),
      ),
    ]),
  );
};

type LogicalRun = {
  face: StampFace;
  level: number;
  text: string;
  /** Where the run sits in visual order: its leftmost character's position. */
  visualPosition: number;
};

/** Maximal stretches of one face at one level, skipping bidi controls. */
const logicalRuns = (
  characters: readonly string[],
  faces: readonly (StampFace | null)[],
  levels: readonly number[],
  visualPositions: readonly number[],
): LogicalRun[] => {
  const runs: LogicalRun[] = [];
  for (const [index, character] of characters.entries()) {
    if (BIDI_CONTROL.test(character)) {
      continue;
    }
    const face = faces[index] ?? null;
    const level = levels[index] ?? 0;
    const visualPosition = visualPositions[index] ?? 0;
    if (face === null) {
      // `stampTextCheck` refuses such text before anything is laid out.
      return panic(
        `No stamp font has U+${(character.codePointAt(0) ?? 0).toString(16)}`,
      );
    }
    const last = runs.at(-1);
    if (last?.face === face && last.level === level) {
      last.text += character;
      last.visualPosition = Math.min(last.visualPosition, visualPosition);
      continue;
    }
    runs.push({ face, level, text: character, visualPosition });
  }
  return runs;
};

/**
 * Lay out one row. `direction` is the paragraph direction, the language of
 * the stamp's labels, never guessed from the text: a Latin name in an
 * Arabic stamp still reads in an Arabic line.
 */
export const layoutStampRow = ({
  direction,
  fonts: { faces, shaper },
  text,
}: {
  direction: PdfSigningStamp["direction"];
  fonts: StampFonts;
  text: string;
}): StampRow => {
  // Levels and faces are per code point, as the bidi resolver reports them.
  const characters = Array.from(text);
  const { levels, visualOrder } = shaper.resolveBidi({
    direction:
      direction === "rtl"
        ? BIDI_DIRECTION.rightToLeft
        : BIDI_DIRECTION.leftToRight,
    text,
  });
  const visualPositions: number[] = [];
  for (const [position, index] of visualOrder.entries()) {
    visualPositions[index] = position;
  }
  const runs = logicalRuns(
    characters,
    assignFaces(faces, characters),
    levels,
    visualPositions,
  )
    // A run at one level is contiguous in visual order, so its leftmost
    // character places the whole run (rule L2 applied to runs).
    .toSorted((a, b) => a.visualPosition - b.visualPosition)
    .map(({ face, level, text: runText }) => {
      const shaped = shaper.shapeRun({
        direction:
          level % 2 === 1
            ? SHAPING_DIRECTION.rightToLeft
            : SHAPING_DIRECTION.leftToRight,
        font: face.font.bytes,
        text: runText,
      });
      const scale = STAMP_UNITS_PER_EM / shaped.unitsPerEm;
      const glyphs = shaped.glyphs.map((glyph) => ({
        cluster: glyph.cluster,
        glyphId: glyph.glyphId,
        xAdvance: glyph.xAdvance * scale,
        xOffset: glyph.xOffset * scale,
        yOffset: glyph.yOffset * scale,
      }));
      if (glyphs.some(({ glyphId }) => glyphId === 0)) {
        // Every character of the run is in the face's cmap (see
        // `assignFaces`), so shaping cannot fall back to .notdef.
        return panic(`The stamp font ${face.key} shaped .notdef`);
      }
      return { clusterText: clusterTexts(runText, glyphs), face, glyphs };
    });
  return {
    runs,
    width: runs.reduce(
      (total, run) =>
        total + run.glyphs.reduce((sum, { xAdvance }) => sum + xAdvance, 0),
      0,
    ),
  };
};

const ISOLATE_INITIATOR = /[\u2066-\u2068]/u;

/**
 * Close, at the end of a row, an isolate that wrapping left open, and
 * reopen it at the start of the next: each row is laid out on its own, and
 * an isolate split across rows would otherwise lose its direction in the
 * second.
 */
const balanceIsolates = (rows: readonly string[]) => {
  const open: string[] = [];
  return rows.map((row) => {
    const reopened = open.join("");
    for (const character of row) {
      if (ISOLATE_INITIATOR.test(character)) {
        open.push(character);
      } else if (character === POP_DIRECTIONAL_ISOLATE) {
        open.pop();
      }
    }
    return `${reopened}${row}${POP_DIRECTIONAL_ISOLATE.repeat(open.length)}`;
  });
};

/** Split a word too wide for a row into pieces that fit, by grapheme. */
const breakWord = (
  word: string,
  maxWidth: number,
  unitWidth: (text: string) => number,
) => {
  const pieces: string[] = [];
  let piece = "";
  for (const { segment } of new Intl.Segmenter().segment(word)) {
    if (piece !== "" && unitWidth(piece + segment) > maxWidth) {
      pieces.push(piece);
      piece = "";
    }
    piece += segment;
  }
  return piece === "" ? pieces : [...pieces, piece];
};

/** Greedy word wrap of one logical line into rows no wider than `maxWidth`. */
const wrapLine = (
  line: string,
  maxWidth: number,
  unitWidth: (text: string) => number,
) => {
  const rows: string[] = [];
  let row = "";
  for (const word of line.split(/\s+/u).filter((entry) => entry !== "")) {
    const candidate = row === "" ? word : `${row} ${word}`;
    if (unitWidth(candidate) <= maxWidth) {
      row = candidate;
      continue;
    }
    if (row !== "") {
      rows.push(row);
    }
    const pieces = breakWord(word, maxWidth, unitWidth);
    rows.push(...pieces.slice(0, -1));
    row = pieces.at(-1) ?? "";
  }
  return balanceIsolates(row === "" ? rows : [...rows, row]);
};

/** Smaller text would not be readable on paper. Sizes are physical points. */
const MIN_FONT_SIZE = 6;
const FONT_SIZE_STEP = 0.5;
const LINE_HEIGHT = 1.25;
/** Absorbs float error, so a fit never depends on the page's UserUnit. */
const FIT_TOLERANCE = 1e-6;

export type PositionedStampRow = {
  row: StampRow;
  fontSize: number;
  /** Left end of the baseline in appearance space. */
  x: number;
  y: number;
};

export type StampColumns = {
  rows: PositionedStampRow[];
  /** The box of the details column, in appearance space. */
  details: { x: number; y: number; width: number; height: number };
};

/**
 * Fit both columns without clipping, each as large as the box allows and
 * centred vertically: the name, one word per line, in at most the left half;
 * the details just right of the name's widest line.
 */
export const layoutStampColumns = ({
  height,
  layoutRow,
  lines,
  unit,
  width,
}: {
  height: number;
  layoutRow: (text: string) => StampRow;
  lines: { name: string; details: readonly string[] };
  /** User-space length of one physical point (1 / UserUnit). */
  unit: number;
  width: number;
}): StampColumns | null => {
  const padding = Math.min(6 * unit, height * 0.1, width * 0.05);
  const innerHeight = height - 2 * padding;
  const unitWidth = (text: string) =>
    layoutRow(text).width / STAMP_UNITS_PER_EM;
  const metrics = (rows: readonly StampRow[]) => {
    const faces = rows.flatMap(({ runs }) => runs.map(({ face }) => face));
    const ascent = Math.max(
      1,
      ...faces.map(({ font }) => font.ascender / font.unitsPerEm),
    );
    const descent = Math.max(
      0,
      ...faces.map(({ font }) => -font.descender / font.unitsPerEm),
    );
    return {
      ascent,
      descent,
      leading: Math.max(LINE_HEIGHT, ascent + descent),
    };
  };
  /** Height, in ems, from the first row's ascent to the last row's descent. */
  const blockEms = (rows: readonly StampRow[]) => {
    const { ascent, descent, leading } = metrics(rows);
    return ascent + descent + Math.max(0, rows.length - 1) * leading;
  };
  const widestEms = (rows: readonly StampRow[]) =>
    Math.max(0, ...rows.map((row) => row.width / STAMP_UNITS_PER_EM));
  const position = (rows: readonly StampRow[], fontSize: number, x: number) => {
    const { ascent, leading } = metrics(rows);
    const top =
      height - padding - (innerHeight - fontSize * blockEms(rows)) / 2;
    return rows.map((row, index) => ({
      row,
      fontSize,
      x,
      y: top - fontSize * (ascent + index * leading),
    }));
  };

  const nameRows = lines.name
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) =>
      layoutRow(`${FIRST_STRONG_ISOLATE}${word}${POP_DIRECTIONAL_ISOLATE}`),
    );
  const nameSize =
    nameRows.length === 0
      ? 0
      : Math.min(
          (width / 2 - 2 * padding) / widestEms(nameRows),
          innerHeight / blockEms(nameRows),
        );
  if (nameRows.length > 0 && nameSize < MIN_FONT_SIZE * unit) {
    return null;
  }
  const detailsX =
    nameRows.length === 0
      ? padding
      : 2 * padding + widestEms(nameRows) * nameSize;
  const detailsWidth = width - padding - detailsX;

  // Every non-blank line takes at least one row of at least 1 em, spaced at
  // least LINE_HEIGHT apart; no size above this bound can fit the height.
  const detailLines = lines.details.filter((line) =>
    line.split(/\s+/u).some((word) => word !== ""),
  ).length;
  const largest =
    innerHeight / unit / (1 + Math.max(0, detailLines - 1) * LINE_HEIGHT);
  for (
    let steps = Math.floor(largest / FONT_SIZE_STEP + FIT_TOLERANCE);
    steps >= MIN_FONT_SIZE / FONT_SIZE_STEP;
    steps -= 1
  ) {
    const fontSize = steps * FONT_SIZE_STEP * unit;
    const rows = lines.details
      .flatMap((line) => wrapLine(line, detailsWidth / fontSize, unitWidth))
      .map(layoutRow);
    if (
      fontSize * blockEms(rows) > innerHeight * (1 + FIT_TOLERANCE) ||
      fontSize * widestEms(rows) > detailsWidth * (1 + FIT_TOLERANCE)
    ) {
      continue;
    }
    return {
      rows: [
        ...position(nameRows, nameSize, padding),
        ...position(rows, fontSize, detailsX),
      ],
      details: {
        x: detailsX,
        y: padding,
        width: detailsWidth,
        height: innerHeight,
      },
    };
  }
  return null;
};
