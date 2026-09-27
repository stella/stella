/**
 * Which text a visible stamp can show.
 *
 * The stamp shapes its text and orders it by the Unicode Bidirectional
 * Algorithm (see `stamp-layout.ts`), in the fallback chain of
 * `stamp-font.ts`. It can draw a script only when the chain has a face for
 * it and that face carries the script's shaping rules: Latin, Greek,
 * Cyrillic, Arabic, Hebrew, Devanagari, Thai, Chinese, Japanese and Korean.
 * Other scripts that need shaping (the other Indic and Southeast Asian
 * scripts, Syriac, N'Ko and the like) would come out as disconnected or
 * misplaced letters, and characters no face has would come out as blanks,
 * so a stamp never draws such text: the fixed labels fall back to English,
 * and a name, reason or location that cannot be drawn refuses the visible
 * stamp, with the invisible signature still available.
 */

import type { PdfSigningStamp } from "@/api/db/schema";
import type {
  StampFace,
  StampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";

/**
 * Scripts that need shaping the chain has no face for, matched by Unicode
 * script property so a new character in one of them is covered without a
 * list of code points; and ideographic variation selectors, which pick a
 * specific glyph of a name the faces cannot select (they carry no
 * variation-sequence mapping), so the stamp would draw a different glyph.
 */
const REFUSED =
  /[\u{E0100}-\u{E01EF}\p{Script=Adlam}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Khmer}\p{Script=Lao}\p{Script=Malayalam}\p{Script=Mandaic}\p{Script=Mongolian}\p{Script=Myanmar}\p{Script=Nko}\p{Script=Oriya}\p{Script=Samaritan}\p{Script=Sinhala}\p{Script=Syriac}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Thaana}\p{Script=Tibetan}]/u;

/**
 * Explicit bidirectional embeddings, overrides and isolates. The stamp
 * isolates each value it inserts, and one of these inside a value could
 * close that isolate early, so they are removed from values: they draw
 * nothing either way.
 */
const EXPLICIT_BIDI_FORMATTING = /[\u202A-\u202E\u2066-\u2069]/gu;

/** A value as the stamp inserts it: without explicit bidi formatting. */
export const stampValue = (value: string) =>
  value.replaceAll(EXPLICIT_BIDI_FORMATTING, "");

/** Characters that draw nothing: joiners, marks, selectors. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

/** Characters of no script: they take the face of the text around them. */
const SCRIPTLESS = /[\p{Script=Common}\p{Script=Inherited}]/u;

const covers = (face: StampFace, codePoint: number) =>
  face.font.glyphIdFor(codePoint) !== 0;

/** The face that draws `character` when it has no neighbour to follow. */
const ownFace = (
  faces: readonly StampFace[],
  character: string,
): StampFace | null => {
  const codePoint = character.codePointAt(0) ?? 0;
  const owner = SCRIPTLESS.test(character)
    ? undefined
    : faces.find(
        (face) => face.owns.test(character) && covers(face, codePoint),
      );
  return owner ?? faces.find((face) => covers(face, codePoint)) ?? null;
};

/**
 * The face for each code point. A scriptless character follows the face
 * before it (or, at the start, the one after it) when that face has it, so
 * a digit or a comma inside Chinese text is drawn in the Chinese face.
 * `null` only where no face has the character (which `canDraw` refuses) or
 * the text is nothing but invisible characters.
 */
export const assignFaces = (
  faces: readonly StampFace[],
  characters: readonly string[],
): (StampFace | null)[] => {
  const own = characters.map((character) =>
    INVISIBLE.test(character) ? null : ownFace(faces, character),
  );
  const assigned = [...own];
  const follow = (index: number, neighbour: StampFace | null | undefined) => {
    const character = characters[index] ?? "";
    if (
      neighbour !== null &&
      neighbour !== undefined &&
      SCRIPTLESS.test(character) &&
      !INVISIBLE.test(character) &&
      covers(neighbour, character.codePointAt(0) ?? 0)
    ) {
      assigned[index] = neighbour;
    }
  };
  for (let index = 1; index < characters.length; index += 1) {
    follow(index, assigned[index - 1]);
  }
  // A leading run of scriptless characters takes the face that follows it.
  const firstScripted = characters.findIndex(
    (character) => !SCRIPTLESS.test(character),
  );
  for (let index = firstScripted - 1; index >= 0; index -= 1) {
    follow(index, assigned[index + 1]);
  }
  // A joiner or selector stays in its neighbour's run: it changes how that
  // run shapes, and the shaper draws nothing for it.
  const invisible = characters.map((character) => INVISIBLE.test(character));
  for (let index = 1; index < characters.length; index += 1) {
    if (invisible[index] === true) {
      assigned[index] ??= assigned[index - 1] ?? null;
    }
  }
  for (let index = characters.length - 2; index >= 0; index -= 1) {
    if (invisible[index] === true) {
      assigned[index] ??= assigned[index + 1] ?? null;
    }
  }
  return assigned;
};

/** The labels a stamp falls back to when the signer's language cannot be drawn. */
export const ENGLISH_STAMP_LABELS: PdfSigningStamp["labels"] = {
  date: "Date",
  location: "Location",
  reason: "Reason",
  signedBy: "Digitally signed by",
};

type StampTextCheck = {
  /** Whether every character of `text` can be shaped and drawn. */
  canDraw: (text: string) => boolean;
};

/** A checker over the stamp's fonts. */
export const stampTextCheck = ({ faces }: StampFonts): StampTextCheck => ({
  canDraw: (text) =>
    !REFUSED.test(text) &&
    // Coverage is per code point: a font maps code points to glyphs.
    Array.from(text).every(
      (character) =>
        INVISIBLE.test(character) || ownFace(faces, character) !== null,
    ),
});

/**
 * The stamp with labels it can draw: the signer's own when every one can
 * be drawn, English otherwise (all four together, never a mix).
 */
export const drawableLabels = (
  stamp: PdfSigningStamp,
  check: StampTextCheck,
): PdfSigningStamp =>
  Object.values(stamp.labels).every((label) => check.canDraw(label))
    ? stamp
    : { ...stamp, direction: "ltr", labels: ENGLISH_STAMP_LABELS };
