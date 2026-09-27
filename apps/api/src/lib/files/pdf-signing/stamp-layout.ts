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
  let current: LogicalRun | null = null;
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
    if (current?.face === face && current.level === level) {
      current.text += character;
      current.visualPosition = Math.min(current.visualPosition, visualPosition);
      continue;
    }
    current = { face, level, text: character, visualPosition };
    runs.push(current);
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
