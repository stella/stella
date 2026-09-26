/**
 * Which text a visible stamp can show.
 *
 * The stamp draws each character as the font's glyph for it, left to
 * right. That is correct for Latin, Greek and Cyrillic text, and wrong for
 * any script whose letters change shape with their neighbours (Arabic,
 * Indic, Southeast Asian scripts) or that reads right to left (Arabic,
 * Hebrew): those would come out as disconnected letters in reverse order.
 * Characters the font has no glyph for would come out as blanks. So a stamp
 * never draws such text: the fixed labels fall back to English, and a name,
 * reason or location that cannot be drawn refuses the visible stamp, with
 * the invisible signature still available.
 */

import { PDF } from "@libpdf/core";

import type { PdfSigningStamp } from "@/api/db/schema";

/**
 * Scripts that need shaping or right-to-left ordering to read correctly.
 * Matched by Unicode script property, so a new character in one of them is
 * covered without a list of code points.
 */
const NEEDS_SHAPING_OR_BIDI =
  /[\p{Script=Adlam}\p{Script=Arabic}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Hebrew}\p{Script=Kannada}\p{Script=Khmer}\p{Script=Lao}\p{Script=Malayalam}\p{Script=Mandaic}\p{Script=Mongolian}\p{Script=Myanmar}\p{Script=Nko}\p{Script=Oriya}\p{Script=Samaritan}\p{Script=Sinhala}\p{Script=Syriac}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Thaana}\p{Script=Thai}\p{Script=Tibetan}‎‏‪-‮⁦-⁩]/u;

/** The labels a stamp falls back to when the signer's language cannot be drawn. */
export const ENGLISH_STAMP_LABELS: PdfSigningStamp["labels"] = {
  date: "Date",
  location: "Location",
  reason: "Reason",
  signedBy: "Digitally signed by",
};

export type StampTextCheck = {
  /** Whether `text` can be drawn glyph by glyph, left to right. */
  canDraw: (text: string) => boolean;
};

/** A checker over the stamp's font. */
export const stampTextCheck = (fontBytes: Uint8Array): StampTextCheck => {
  const font = PDF.create().embedFont(fontBytes);
  return {
    canDraw: (text) =>
      !NEEDS_SHAPING_OR_BIDI.test(text) && font.canEncode(text),
  };
};

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
