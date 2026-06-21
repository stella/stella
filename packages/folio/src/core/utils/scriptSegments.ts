/**
 * Script segmentation for per-character East-Asian font selection.
 *
 * Word resolves a run's font per character: East-Asian (CJK) code points use
 * the run's `w:eastAsia` font slot, everything else uses `w:ascii`/`w:hAnsi`.
 * folio mirrors this by splitting a run's text into maximal same-script
 * segments that the measurer and the painter both consume, so line wrapping
 * stays in sync with rendering.
 *
 * Ranges are authored with `\u` escapes only — never pasted glyphs (a pasted
 * glyph once silently corrupted an RTL character class here).
 */

export type ScriptSegment = {
  text: string;
  isCjk: boolean;
};

/**
 * True when a code point belongs to an East-Asian script that Word renders with
 * the `w:eastAsia` font slot: CJK ideographs, kana, Hangul, CJK symbols and
 * punctuation, and fullwidth/halfwidth forms.
 */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x30_00 && cp <= 0x30_3f) || // CJK symbols and punctuation
    (cp >= 0x30_40 && cp <= 0x30_ff) || // Hiragana + Katakana
    (cp >= 0x31_f0 && cp <= 0x31_ff) || // Katakana phonetic extensions
    (cp >= 0x34_00 && cp <= 0x4d_bf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e_00 && cp <= 0x9f_ff) || // CJK Unified Ideographs
    (cp >= 0xf9_00 && cp <= 0xfa_ff) || // CJK compatibility ideographs
    (cp >= 0xac_00 && cp <= 0xd7_af) || // Hangul syllables
    (cp >= 0x11_00 && cp <= 0x11_ff) || // Hangul Jamo
    (cp >= 0x31_30 && cp <= 0x31_8f) || // Hangul compatibility Jamo
    (cp >= 0xff_00 && cp <= 0xff_ef) || // Halfwidth and fullwidth forms
    (cp >= 0x2_00_00 && cp <= 0x3_ff_ff) // CJK Unified Ideographs Extension B+ (astral)
  );
}

/**
 * True when the text contains at least one East-Asian code point. Callers use
 * this to skip segmentation entirely on the common all-Latin path.
 */
export function hasCjk(text: string): boolean {
  for (const ch of text) {
    // SAFETY: for...of over a string yields whole code points.
    if (isCjkCodePoint(ch.codePointAt(0)!)) {
      return true;
    }
  }
  return false;
}

/**
 * Split text into maximal runs of one script class (CJK vs. non-CJK). Iterates
 * by code point so astral ideographs (surrogate pairs) are never split between
 * fonts. Empty input yields no segments; single-class input yields one.
 */
export function segmentByScript(text: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  let current = "";
  let currentIsCjk = false;

  for (const ch of text) {
    // SAFETY: for...of over a string yields whole code points.
    const cjk = isCjkCodePoint(ch.codePointAt(0)!);
    if (current.length === 0) {
      current = ch;
      currentIsCjk = cjk;
      continue;
    }
    if (cjk === currentIsCjk) {
      current += ch;
      continue;
    }
    segments.push({ text: current, isCjk: currentIsCjk });
    current = ch;
    currentIsCjk = cjk;
  }

  if (current.length > 0) {
    segments.push({ text: current, isCjk: currentIsCjk });
  }

  return segments;
}
