/**
 * First-strong base-direction detection (the Unicode `dir="auto"` rule).
 *
 * Scans text for the first *strong* directional signal — an explicit bidi
 * control (RLM / ALM => RTL, LRM => LTR) or the first letter (`\p{L}`) — and
 * reports the base paragraph direction it implies. Digits, combining marks,
 * punctuation and whitespace are weak/neutral and skipped. Text with no strong
 * character returns `null` (undecided; the caller decides the default).
 *
 * Shared by the layout painter (paragraph base direction) and the auto-bidi
 * detector (sets `w:bidi` on Arabic/Hebrew-led paragraphs that arrived without
 * an explicit direction flag).
 */

// Strong-RTL letters, matched by Unicode script so RTL scripts outside the BMP
// (Adlam U+1E900) and newer blocks (Arabic Extended-B U+0870) are covered
// without hand-rolling code-point ranges. These eight cover every RTL script in
// real-world use (Hebrew/Arabic are ~all of it); newer scripts (Yezidi, Garay,
// …) are omitted because the pinned oxlint/tsc Unicode database rejects their
// names. Only used to classify the first *letter* (`\p{L}`), so the non-letter
// members of these scripts (Arabic-Indic digits, combining marks, punctuation)
// are never tested — they're weak/neutral and skipped upstream.
export const RTL_STRONG_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

const LETTER = /\p{L}/u;

// Explicit bidi controls, by code point (decimal — hex literals trip the
// numeric-separators lint). RLM U+200F and ALM U+061C force RTL; LRM U+200E
// forces LTR.
const RLM = 8207;
const ALM = 1564;
const LRM = 8206;

export type BaseDirection = "rtl" | "ltr";

/**
 * Resolve the first-strong base direction of `text`, or `null` when the text
 * carries no strong directional character.
 */
export function detectBaseDirection(text: string): BaseDirection | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === RLM || cp === ALM) {
      return "rtl";
    }
    if (cp === LRM) {
      return "ltr";
    }
    if (LETTER.test(ch)) {
      return RTL_STRONG_LETTER.test(ch) ? "rtl" : "ltr";
    }
  }
  return null;
}
