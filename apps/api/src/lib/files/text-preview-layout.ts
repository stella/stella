/**
 * Plain text set into rows for a PDF preview, in the fonts and with the
 * shaper the visible signature stamp uses (see `pdf-signing/stamp-font.ts`):
 * DejaVu Sans for Latin, Greek, Cyrillic, Arabic and Hebrew, then Noto
 * subsets for Devanagari, Thai, CJK and Hangul.
 *
 * A paragraph is resolved once by the Unicode Bidirectional Algorithm, its
 * paragraph direction taken from its first strong character (rules P2 and
 * P3), split into runs of one face at one level, and each run is shaped
 * once. Lines are then broken on the shaped advances: after spaces, between
 * ideographs (except before closing and after opening CJK punctuation),
 * after a hyphen between letters, and, for a word wider than the line, at
 * the last cluster boundary that fits. Each row is put in visual order by
 * rule L2 over the paragraph's levels.
 *
 * A character no face can draw is shown as U+FFFD, so a file in a script
 * the fonts lack shows where its text is rather than nothing.
 */

import { panic } from "better-result";

import {
  BIDI_DIRECTION,
  SHAPING_DIRECTION,
} from "@stll/folio-core/text-shaping";

import type {
  StampFace,
  StampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import {
  BIDI_CONTROL,
  clusterTexts,
  STAMP_UNITS_PER_EM,
  type StampGlyph,
  type StampRow,
  type StampRun,
} from "@/api/lib/files/pdf-signing/stamp-layout";
import { assignFaces } from "@/api/lib/files/pdf-signing/stamp-text";

/** Characters that draw nothing: joiners, marks, selectors. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/** Control characters: none draws, and a tab is expanded before layout. */
const CONTROL = /\p{Cc}/u;
/** Spaces a line may break after. No-break spaces are not among them. */
const BREAKING_SPACE = /[ \u1680\u2000-\u2006\u2008-\u200A\u205F\u3000]/u;
/** Characters a line may break between, as in CJK text without spaces. */
const IDEOGRAPHIC =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;
/** Closing CJK punctuation and marks that never start a line. */
const NO_BREAK_BEFORE =
  /[\u3001\u3002\uFF0C\uFF0E\u30FB\uFF1A\uFF1B\uFF1F\uFF01\uFF09\u300D\u300F\u3011\u3015\u3009\u300B\u3019\u3017\u301F\uFF5D\uFF3D\u2026\u2025\u30FC\u3005\u309D\u309E\u30FD\u30FE\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6,.:;?!)\]}]/u;
/** Opening CJK punctuation that never ends a line. */
const NO_BREAK_AFTER =
  /[\uFF08\u300C\u300E\u3010\u3014\u3008\u300A\u3018\u3016\u301D\uFF5B\uFF3B([{]/u;
const LETTER = /\p{L}/u;
const HYPHEN = /[-\u2010]/u;
const REPLACEMENT_CHARACTER = "\uFFFD";
/** The smallest line pitch, in ems. */
const LINE_PITCH_MIN = 1.25;

/** A paragraph longer than this many code points is laid out in pieces. */
const PARAGRAPH_PIECE_MAX = 4096;

export type TextRow = {
  row: StampRow;
  /** The paragraph reads right to left, so the row aligns right. */
  rtl: boolean;
};

const utf8 = new TextEncoder();

/**
 * The text with every character no face can draw replaced by U+FFFD and
 * control characters removed. Coverage is cached per code point.
 */
const drawableText = (
  faces: readonly StampFace[],
  text: string,
  coverage: Map<number, boolean>,
) => {
  let out = "";
  for (const character of text) {
    if (CONTROL.test(character)) {
      continue;
    }
    if (INVISIBLE.test(character)) {
      out += character;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    let covered = coverage.get(codePoint);
    if (covered === undefined) {
      covered = faces.some((face) => face.font.glyphIdFor(codePoint) !== 0);
      coverage.set(codePoint, covered);
    }
    out += covered ? character : REPLACEMENT_CHARACTER;
  }
  return out;
};

/**
 * Left-to-right text in scripts that draw one glyph per character, with no
 * combining mark or invisible character: Latin, Greek, Cyrillic, and CJK
 * and Hangul (whose faces carry no layout tables). Such a run is set from
 * the face's character map and advances alone, as folio lays out these
 * scripts, without the shaper.
 */
const NEEDS_NO_SHAPING =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Common}]*$/u;
const MARK_OR_INVISIBLE = /[\p{M}\p{Default_Ignorable_Code_Point}]/u;

/** A run set glyph by glyph from the face's character map. */
const mappedRun = (face: StampFace, text: string) => {
  const glyphs: {
    glyphId: number;
    cluster: number;
    xAdvance: number;
    xOffset: number;
    yOffset: number;
  }[] = [];
  let cluster = 0;
  for (const character of text) {
    const glyphId = face.font.glyphIdFor(character.codePointAt(0) ?? 0);
    glyphs.push({
      cluster,
      glyphId,
      xAdvance: face.font.advanceWidthFor(glyphId),
      xOffset: 0,
      yOffset: 0,
    });
    cluster += utf8.encode(character).length;
  }
  return { glyphs, unitsPerEm: face.font.unitsPerEm };
};

type ShapedGlyph = StampGlyph & {
  /** Index, in the paragraph, of the character starting the glyph's cluster. */
  owner: number;
};

type ShapedRun = {
  face: StampFace;
  level: number;
  /** Paragraph index of the run's first and one past its last character. */
  start: number;
  end: number;
  /** Glyphs in visual order. */
  glyphs: ShapedGlyph[];
  clusterText: ReadonlyMap<number, string>;
};

type ShapedParagraph = {
  characters: readonly string[];
  rtl: boolean;
  runs: readonly ShapedRun[];
  /** Advance of each character, in thousandths of an em; 0 inside a cluster. */
  advances: Float64Array;
  /** Cluster id of each character; a line breaks only where it changes. */
  clusters: Int32Array;
};

const shapeParagraph = (
  { faces, shaper }: StampFonts,
  text: string,
): ShapedParagraph => {
  const characters = Array.from(text);
  const { levels, paragraphLevel } = shaper.resolveBidi({
    direction: BIDI_DIRECTION.auto,
    text,
  });
  const assigned = assignFaces(faces, characters);
  const advances = new Float64Array(characters.length);
  const clusters = new Int32Array(characters.length);
  let nextCluster = 0;
  const runs: ShapedRun[] = [];
  let index = 0;
  while (index < characters.length) {
    const face = assigned[index] ?? null;
    const level = levels[index] ?? paragraphLevel;
    if (face === null || BIDI_CONTROL.test(characters[index] ?? "")) {
      // Draws nothing: a bidi control, or an invisible character with no
      // visible neighbour to take a face from.
      clusters[index] = nextCluster;
      nextCluster += 1;
      index += 1;
      continue;
    }
    const start = index;
    while (
      index < characters.length &&
      assigned[index] === face &&
      (levels[index] ?? paragraphLevel) === level &&
      !BIDI_CONTROL.test(characters[index] ?? "")
    ) {
      index += 1;
    }
    const runText = characters.slice(start, index).join("");
    // UTF-8 offset of each character in the run, as the shaper's clusters.
    const ownerAt = new Map<number, number>();
    let offset = 0;
    for (let position = start; position < index; position += 1) {
      ownerAt.set(offset, position);
      offset += utf8.encode(characters[position] ?? "").length;
    }
    const shaped =
      level % 2 === 0 &&
      NEEDS_NO_SHAPING.test(runText) &&
      !MARK_OR_INVISIBLE.test(runText)
        ? mappedRun(face, runText)
        : shaper.shapeRun({
            direction:
              level % 2 === 1
                ? SHAPING_DIRECTION.rightToLeft
                : SHAPING_DIRECTION.leftToRight,
            font: face.font.bytes,
            text: runText,
          });
    const scale = STAMP_UNITS_PER_EM / shaped.unitsPerEm;
    const glyphs = shaped.glyphs.map((glyph): ShapedGlyph => {
      const owner =
        ownerAt.get(glyph.cluster) ??
        panic("A shaped cluster does not start at a character");
      const xAdvance = glyph.xAdvance * scale;
      advances[owner] = (advances[owner] ?? 0) + xAdvance;
      return {
        cluster: glyph.cluster,
        glyphId: glyph.glyphId,
        owner,
        xAdvance,
        xOffset: glyph.xOffset * scale,
        yOffset: glyph.yOffset * scale,
      };
    });
    // A character belongs to the cluster of the nearest cluster start at or
    // before it, in logical order.
    const starts = new Set(glyphs.map(({ owner }) => owner));
    let current = -1;
    for (let position = start; position < index; position += 1) {
      if (starts.has(position) || current === -1) {
        current = nextCluster;
        nextCluster += 1;
      }
      clusters[position] = current;
    }
    runs.push({
      clusterText: clusterTexts(runText, glyphs),
      end: index,
      face,
      glyphs,
      level,
      start,
    });
  }
  return { advances, characters, clusters, rtl: paragraphLevel === 1, runs };
};

const isSpace = (character: string | undefined) =>
  character !== undefined && BREAKING_SPACE.test(character);

/** Whether a line may break before character `index` of the paragraph. */
const canBreakBefore = (
  { characters, clusters }: ShapedParagraph,
  index: number,
) => {
  if (index <= 0 || index >= characters.length) {
    return false;
  }
  if (clusters[index] === clusters[index - 1]) {
    return false;
  }
  const before = characters[index - 1] ?? "";
  const after = characters[index] ?? "";
  if (isSpace(after)) {
    return false;
  }
  if (isSpace(before)) {
    return true;
  }
  if (IDEOGRAPHIC.test(before) || IDEOGRAPHIC.test(after)) {
    return !NO_BREAK_BEFORE.test(after) && !NO_BREAK_AFTER.test(before);
  }
  return (
    HYPHEN.test(before) &&
    LETTER.test(characters[index - 2] ?? "") &&
    LETTER.test(after)
  );
};

/** Where each row of the paragraph starts and ends, spaces at breaks dropped. */
const breakParagraph = (paragraph: ShapedParagraph, maxWidth: number) => {
  const { advances, characters, clusters } = paragraph;
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < characters.length) {
    let width = 0;
    let lastBreak = -1;
    let end = characters.length;
    for (let index = start; index < characters.length; index += 1) {
      if (index > start && canBreakBefore(paragraph, index)) {
        lastBreak = index;
      }
      const advance = advances[index] ?? 0;
      if (
        index > start &&
        !isSpace(characters[index]) &&
        width + advance > maxWidth
      ) {
        if (lastBreak > start) {
          end = lastBreak;
        } else {
          // Nothing breaks the word: cut it at the last cluster boundary
          // that fits, or after its first cluster when none does.
          let cut = index;
          while (cut > start && clusters[cut] === clusters[cut - 1]) {
            cut -= 1;
          }
          if (cut === start) {
            cut = index + 1;
            while (
              cut < characters.length &&
              clusters[cut] === clusters[cut - 1]
            ) {
              cut += 1;
            }
          }
          end = cut;
        }
        break;
      }
      width += advance;
    }
    let trimmed = end;
    while (trimmed > start && isSpace(characters[trimmed - 1])) {
      trimmed -= 1;
    }
    ranges.push([start, trimmed]);
    start = end;
    while (start < characters.length && isSpace(characters[start])) {
      start += 1;
    }
  }
  return ranges;
};

type Piece = { run: ShapedRun; glyphs: ShapedGlyph[] };

/** The part of the paragraph in `[start, end)` as one row in visual order. */
const rowOf = (
  { runs }: ShapedParagraph,
  start: number,
  end: number,
): StampRow => {
  const pieces: Piece[] = [];
  for (const run of runs) {
    if (run.end <= start || run.start >= end) {
      continue;
    }
    const glyphs = run.glyphs.filter(
      ({ owner }) => owner >= start && owner < end,
    );
    if (glyphs.length > 0) {
      pieces.push({ glyphs, run });
    }
  }
  // Rule L2: from the highest level down to the lowest odd one, reverse
  // every stretch of pieces at that level or higher.
  const levels = pieces.map(({ run }) => run.level);
  const highest = Math.max(0, ...levels);
  const lowestOdd = Math.min(
    ...levels.map((level) => (level % 2 === 1 ? level : level + 1)),
  );
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let index = 0;
    while (index < pieces.length) {
      if ((pieces[index]?.run.level ?? 0) < level) {
        index += 1;
        continue;
      }
      let stretchEnd = index;
      while (
        stretchEnd < pieces.length &&
        (pieces[stretchEnd]?.run.level ?? 0) >= level
      ) {
        stretchEnd += 1;
      }
      const reversed = pieces.slice(index, stretchEnd).toReversed();
      pieces.splice(index, reversed.length, ...reversed);
      index = stretchEnd;
    }
  }
  const stampRuns: StampRun[] = pieces.map(({ glyphs, run }) => ({
    clusterText: run.clusterText,
    face: run.face,
    glyphs: glyphs.map(({ cluster, glyphId, xAdvance, xOffset, yOffset }) => ({
      cluster,
      glyphId,
      xAdvance,
      xOffset,
      yOffset,
    })),
  }));
  return {
    runs: stampRuns,
    width: stampRuns.reduce(
      (total, run) =>
        total + run.glyphs.reduce((sum, { xAdvance }) => sum + xAdvance, 0),
      0,
    ),
  };
};

/** Drawable text set into rows; one empty row when nothing in it draws. */
const setParagraph = (
  fonts: StampFonts,
  drawable: string,
  maxWidth: number,
): TextRow[] => {
  if (!Array.from(drawable).some((character) => !INVISIBLE.test(character))) {
    return [{ row: { runs: [], width: 0 }, rtl: false }];
  }
  const paragraph = shapeParagraph(fonts, drawable);
  return breakParagraph(paragraph, maxWidth).map(([start, end]) => ({
    row: rowOf(paragraph, start, end),
    rtl: paragraph.rtl,
  }));
};

export type TextLayout = {
  fonts: StampFonts;
  /** Code points already checked against the faces. */
  coverage: Map<number, boolean>;
  /**
   * Short paragraphs already set, by width and text: a table repeats the
   * same few values (a currency, a status) down a column.
   */
  repeated: Map<string, TextRow[]>;
};

/** Paragraphs up to this many UTF-16 units are kept for reuse. */
const REUSED_PARAGRAPH_MAX = 64;
/** Kept paragraphs before the store starts over, bounding its memory. */
const REUSED_PARAGRAPHS_MAX = 4096;

export const textLayout = (fonts: StampFonts): TextLayout => ({
  coverage: new Map(),
  fonts,
  repeated: new Map(),
});

/**
 * One paragraph (a line of the file, with no line break inside) set into
 * rows no wider than `maxWidth` thousandths of an em. A paragraph with
 * nothing to draw is one empty row. The rows returned are shared and never
 * modified.
 */
export const layoutParagraph = (
  { coverage, fonts, repeated }: TextLayout,
  text: string,
  maxWidth: number,
): TextRow[] => {
  const key =
    text.length <= REUSED_PARAGRAPH_MAX ? `${maxWidth}:${text}` : null;
  const known = key === null ? undefined : repeated.get(key);
  if (known !== undefined) {
    return known;
  }
  const drawable = drawableText(fonts.faces, text, coverage);
  const rows = setParagraph(fonts, drawable, maxWidth);
  if (key !== null) {
    if (repeated.size >= REUSED_PARAGRAPHS_MAX) {
      repeated.clear();
    }
    repeated.set(key, rows);
  }
  return rows;
};

/**
 * `line` cut into pieces of at most {@link PARAGRAPH_PIECE_MAX} code points,
 * each ending after a space where one is near the limit, so one enormous
 * line is shaped piece by piece instead of all at once.
 */
export const paragraphPieces = (line: string): string[] => {
  const characters = Array.from(line);
  if (characters.length <= PARAGRAPH_PIECE_MAX) {
    return [line];
  }
  const pieces: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + PARAGRAPH_PIECE_MAX, characters.length);
    if (end < characters.length) {
      for (
        let space = end;
        space > start + PARAGRAPH_PIECE_MAX / 2;
        space -= 1
      ) {
        if (isSpace(characters[space - 1])) {
          end = space;
          break;
        }
      }
    }
    pieces.push(characters.slice(start, end).join(""));
    start = end;
  }
  return pieces;
};

/** Ascent and line pitch of a row, in ems, from the faces it draws in. */
export const rowMetrics = (row: StampRow, base: StampFace) => {
  const faces = [base, ...row.runs.map(({ face }) => face)];
  const ascent = Math.max(
    ...faces.map(({ font }) => font.ascender / font.unitsPerEm),
  );
  const descent = Math.max(
    ...faces.map(({ font }) => -font.descender / font.unitsPerEm),
  );
  return { ascent, pitch: Math.max(LINE_PITCH_MIN, ascent + descent) };
};
