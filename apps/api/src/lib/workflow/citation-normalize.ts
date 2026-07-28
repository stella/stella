/**
 * Canonical normalizer for deciding whether an AI citation's quoted
 * text corresponds to real source content.
 *
 * A citation is *verified* when its quote matches an allow-listed
 * source block and *unverified* when it matches nothing. That decision
 * must never hinge on a cosmetic character difference: a non-breaking
 * space, a curly apostrophe, an en dash, or a decomposed accent inside
 * an otherwise-identical quote must still compare equal. Every
 * comparison site routes through the single normalizer here so the
 * folding rules can never drift per call site.
 *
 * The normalized form is for COMPARISON ONLY. The displayed citation
 * always keeps its original characters — accents, spacing, and quotes
 * are preserved verbatim for the reader; only the comparison key is
 * folded.
 */

export type CitationNormalizeOptions = {
  /**
   * Fold case before comparing. Defaults to true: legal quotes are
   * frequently re-cased ("The Party" vs "the party") without changing
   * which source they point at. The displayed text is never lowered.
   */
  caseFold?: boolean;
};

// Zero-width code points carry no visible content but break naive
// equality. Stripped outright (not spaced) so a zero-width joiner
// sitting between two words does not manufacture a word boundary.
// Written as escaped alternation rather than a character class: a class
// containing a joiner trips no-misleading-character-class, and escapes
// keep the invisible code points reviewable.
//   U+200B ZERO WIDTH SPACE      U+200C ZERO WIDTH NON-JOINER
//   U+200D ZERO WIDTH JOINER     U+2060 WORD JOINER
//   U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\u2060|\uFEFF/gu;

// Dash-like separators folded to ASCII hyphen-minus. Legal text mixes
// these freely (hyphenated terms, numeric ranges, minus signs):
//   U+002D HYPHEN-MINUS        U+2010 HYPHEN
//   U+2011 NON-BREAKING HYPHEN U+2012 FIGURE DASH
//   U+2013 EN DASH             U+2014 EM DASH
//   U+2015 HORIZONTAL BAR      U+2212 MINUS SIGN
const DASHES = /[-‐‑‒–—―−]/gu;

// Single-quote-like marks folded to a straight apostrophe:
//   U+2018/U+2019 curly single quotes  U+201A/U+201B low/high-reversed
//   U+2032 PRIME                        U+2035 REVERSED PRIME
const SINGLE_QUOTES = /[‘’‚‛′‵]/gu;

// Double-quote-like marks folded to a straight quotation mark:
//   U+201C/U+201D curly double quotes  U+201E/U+201F low/high-reversed
//   U+2033 DOUBLE PRIME                 U+2036 REVERSED DOUBLE PRIME
const DOUBLE_QUOTES = /[“”„‟″‶]/gu;

// Runs of any Unicode whitespace collapse to a single ASCII space.
// The JS `\s` class already covers tab, newline, NBSP (U+00A0), narrow
// no-break space (U+202F), the U+2000–U+200A range, U+205F, U+3000, and
// the line/paragraph separators, so a dedicated space table is not
// needed here — only the zero-width strip above, which `\s` omits.
const WHITESPACE_RUN = /\s+/gu;

/**
 * Fold a string to its comparison key. Order matters: compose accents
 * first (so "e" + combining acute and precomposed "é" converge), strip
 * zero-width, fold dash/quote variants, then collapse whitespace and
 * trim. Case folding, when enabled, runs last on the already-composed
 * form.
 */
export const normalizeForCitationMatch = (
  text: string,
  { caseFold = true }: CitationNormalizeOptions = {},
): string => {
  const folded = text
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(WHITESPACE_RUN, " ")
    .trim();
  return caseFold ? folded.toLowerCase() : folded;
};

export type CitationTextMatchesOptions = CitationNormalizeOptions & {
  quote: string;
  source: string;
};

/**
 * True when `quote` corresponds to `source` after normalization.
 *
 * A citation is often a span of a larger paragraph, so an exact match
 * is tried first and then contiguous containment of the normalized
 * quote within the normalized source. The match is deterministic and
 * bounded — no fuzzy or edit-distance scoring — so a "verified" verdict
 * always means the exact folded characters are present in the source.
 */
export const citationTextMatches = ({
  quote,
  source,
  caseFold,
}: CitationTextMatchesOptions): boolean => {
  const normalizedQuote = normalizeForCitationMatch(quote, { caseFold });
  if (normalizedQuote.length === 0) {
    return false;
  }
  const normalizedSource = normalizeForCitationMatch(source, { caseFold });
  if (normalizedQuote === normalizedSource) {
    return true;
  }
  return normalizedSource.includes(normalizedQuote);
};
