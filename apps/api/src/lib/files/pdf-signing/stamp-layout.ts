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
import {
  STAMP_DETAIL_COLOR,
  STAMP_NAME_COLOR,
} from "@/api/lib/files/pdf-signing/stamp-colors";
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
/** The details are set at about this fraction of the name size. */
const DETAILS_TO_NAME = 0.4;
/** Stroke width of the rule between the columns, in points. */
const RULE_WIDTH = 1.5;
/** Space between the mark and the first details row, in ems of that row. */
const MARK_GAP = 0.4;
/** Absorbs float error, so a fit never depends on the UserUnit of a page. */
const FIT_TOLERANCE = 1e-6;

export type StampWeight = "regular" | "bold";

/** One logical line of the details column. */
export type StampDetailLine = {
  text: string;
  /** The signer name, set bold and near-black like the name column. */
  signer: boolean;
};

export type PositionedStampRow = {
  row: StampRow;
  fontSize: number;
  /** DeviceRGB components the row is filled with. */
  color: string;
  /** Left end of the baseline in appearance space. */
  x: number;
  y: number;
};

export type StampColumns = {
  rows: PositionedStampRow[];
  /**
   * The box of the mark at the start of the first details row: one cap
   * height tall, standing on the baseline of that row.
   */
  mark: { x: number; y: number; width: number; height: number } | null;
  /**
   * The rule between the columns: its centre line and stroke width; `top`
   * and `bottom` are the painted ends, caps included, spanning the details.
   */
  rule: { x: number; top: number; bottom: number; width: number } | null;
};

/**
 * Fit both columns without clipping, centred vertically: the name in bold,
 * one word per line, as large as it fits in at most the left half; a rule
 * one padding right of its widest line; and the details one padding beyond,
 * at about 0.4 times the name size or smaller where the box needs it, the
 * mark before their first row.
 */
export const layoutStampColumns = ({
  direction,
  height,
  layoutRow,
  lines,
  mark,
  unit,
  width,
}: {
  direction: PdfSigningStamp["direction"];
  height: number;
  layoutRow: (text: string, weight: StampWeight) => StampRow;
  lines: { name: string; details: readonly StampDetailLine[] };
  /** Width over height of the mark. */
  mark: { aspect: number };
  /** User-space length of one physical point (1 / UserUnit). */
  unit: number;
  width: number;
}): StampColumns | null => {
  const padding = Math.min(6 * unit, height * 0.1, width * 0.05);
  const innerHeight = height - 2 * padding;
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
  /** Height, in ems, from the ascent of the first row to the descent of the last. */
  const blockEms = (rows: readonly StampRow[]) => {
    const { ascent, descent, leading } = metrics(rows);
    return ascent + descent + Math.max(0, rows.length - 1) * leading;
  };
  const widestEms = (rows: readonly StampRow[]) =>
    Math.max(0, ...rows.map((row) => row.width / STAMP_UNITS_PER_EM));
  /** The top of a block of `rows`, centred in the box. */
  const blockTop = (rows: readonly StampRow[], fontSize: number) =>
    height - padding - (innerHeight - fontSize * blockEms(rows)) / 2;
  /** Baselines of `rows`, top to bottom, the block centred in the box. */
  const baselines = (rows: readonly StampRow[], fontSize: number) => {
    const { ascent, leading } = metrics(rows);
    const top = blockTop(rows, fontSize);
    return rows.map((_, index) => top - fontSize * (ascent + index * leading));
  };

  const nameRows = lines.name
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) =>
      layoutRow(
        `${FIRST_STRONG_ISOLATE}${word}${POP_DIRECTIONAL_ISOLATE}`,
        "bold",
      ),
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
  const ruleWidth = RULE_WIDTH * unit;
  const ruleX =
    nameRows.length === 0
      ? null
      : 2 * padding + widestEms(nameRows) * nameSize + ruleWidth / 2;
  const detailsX = ruleX === null ? padding : ruleX + ruleWidth / 2 + padding;
  const detailsWidth = width - padding - detailsX;

  const weightOf = ({ signer }: StampDetailLine): StampWeight =>
    signer ? "bold" : "regular";
  const [firstLine] = lines.details;
  // The mark is one cap height of the first row tall, a gap after it.
  const capEms =
    firstLine === undefined
      ? 0
      : Math.max(
          0,
          ...layoutRow(firstLine.text, weightOf(firstLine)).runs.map(
            ({ face: { font } }) => font.capHeight / font.unitsPerEm,
          ),
        );
  const markEms = capEms * mark.aspect;
  const markAdvanceEms = markEms === 0 ? 0 : markEms + MARK_GAP;

  // Every non-blank line takes at least one row of at least 1 em, spaced at
  // least LINE_HEIGHT apart; no size above this bound can fit the height.
  const detailLines = lines.details.filter(({ text }) =>
    text.split(/\s+/u).some((word) => word !== ""),
  ).length;
  const largest =
    innerHeight / unit / (1 + Math.max(0, detailLines - 1) * LINE_HEIGHT);
  const preferred =
    nameRows.length === 0
      ? largest
      : Math.max(MIN_FONT_SIZE, (nameSize / unit) * DETAILS_TO_NAME);
  for (
    let steps = Math.floor(
      Math.min(largest, preferred) / FONT_SIZE_STEP + FIT_TOLERANCE,
    );
    steps >= MIN_FONT_SIZE / FONT_SIZE_STEP;
    steps -= 1
  ) {
    const fontSize = steps * FONT_SIZE_STEP * unit;
    const columnEms = detailsWidth / fontSize;
    const details = lines.details.flatMap((line, index) => {
      const weight = weightOf(line);
      const room = index === 0 ? columnEms - markAdvanceEms : columnEms;
      return wrapLine(
        line.text,
        room,
        (text) => layoutRow(text, weight).width / STAMP_UNITS_PER_EM,
      ).map((text, row) => ({
        line,
        marked: index === 0 && row === 0,
        row: layoutRow(text, weight),
      }));
    });
    const rows = details.map(({ row }) => row);
    if (
      fontSize * blockEms(rows) > innerHeight * (1 + FIT_TOLERANCE) ||
      details.some(
        ({ marked, row }) =>
          fontSize *
            (row.width / STAMP_UNITS_PER_EM + (marked ? markAdvanceEms : 0)) >
          detailsWidth * (1 + FIT_TOLERANCE),
      )
    ) {
      continue;
    }
    const nameBaselines = baselines(nameRows, nameSize);
    const detailBaselines = baselines(rows, fontSize);
    const leadRow = details.at(0);
    const markWidth = markEms * fontSize;
    // At the start of the row: its left in a left-to-right stamp, its right
    // in a right-to-left one, where the row itself starts at the column.
    const markBox =
      leadRow === undefined || markWidth === 0
        ? null
        : {
            x:
              direction === "rtl"
                ? detailsX +
                  fontSize * (leadRow.row.width / STAMP_UNITS_PER_EM + MARK_GAP)
                : detailsX,
            y: detailBaselines.at(0) ?? 0,
            width: markWidth,
            height: capEms * fontSize,
          };
    const top = blockTop(rows, fontSize);
    return {
      rows: [
        ...nameRows.map((row, index) => ({
          row,
          fontSize: nameSize,
          color: STAMP_NAME_COLOR,
          x: padding,
          y: nameBaselines[index] ?? 0,
        })),
        ...details.map(({ line, marked, row }, index) => ({
          row,
          fontSize,
          color: line.signer ? STAMP_NAME_COLOR : STAMP_DETAIL_COLOR,
          x:
            marked && direction !== "rtl"
              ? detailsX + markAdvanceEms * fontSize
              : detailsX,
          y: detailBaselines[index] ?? 0,
        })),
      ],
      mark: markBox,
      rule:
        ruleX === null || rows.length === 0
          ? null
          : {
              x: ruleX,
              top,
              bottom: top - fontSize * blockEms(rows),
              width: ruleWidth,
            },
    };
  }
  return null;
};
