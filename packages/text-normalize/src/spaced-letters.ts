/**
 * Collapse spaced-out letters used for emphasis in court PDFs.
 *
 * Slovak and Czech courts format words with letter-spacing:
 *   `r o z h o d o l :` -> `rozhodol:`
 *   `o d ô v o d n e n i e :` -> `odôvodnenie:`
 *   `z a m i e t a` -> `zamieta`
 *
 * These break full-text search ("rozhodol" won't match
 * "r o z h o d o l"). We collapse runs of single Unicode letters
 * separated by single spaces, optionally followed by punctuation.
 *
 * Requires at least FOUR letters in the run. Czech/Slovak have many
 * single-letter words (prepositions a, i, k, o, s, u, v, z), so a 2–3
 * letter run like `u a v` ("u", "a", "v") is far more likely to be real
 * words than letter-spaced emphasis; collapsing it to `uav` would corrupt
 * the text. Genuine spaced words ("z a m i e t a", "r o z h o d o l") are
 * always longer, so the floor loses nothing in practice.
 *
 * This is the single source of the threshold: the ingestion pipeline
 * (index-time) and the case-viewer find-in-page normalizer (query-time)
 * both consume it, so a spaced heading collapses identically on both
 * sides and highlight offsets stay aligned.
 */

// `\p{L} (?:\p{L} ){2,}\p{L}` is four or more spaced letters: one leading
// letter, at least two interior letters, one trailing letter. Anchored by
// whitespace/string boundaries so it never touches normal words, digits,
// or case references.
const buildSpacedLetterRunSource = () =>
  "(?<=\\s|^)(?:\\p{L} (?:\\p{L} ){2,}\\p{L})(?: ?[,:;.!?])?(?=\\s|$)";

/**
 * A fresh global RegExp matching one spaced-letter run. Returned from a
 * factory (not a shared constant) because callers use it with both
 * `String.replace` and `String.matchAll`; a fresh instance avoids any
 * shared `lastIndex` surprises.
 */
export const spacedLetterRunRegex = (): RegExp =>
  new RegExp(buildSpacedLetterRunSource(), "gu");

const MULTI_SPACE_RE = / {2,}/gu;
const SPACE_RE = / /gu;

// Single-entry cache: sk-courts.ts's classifiers (isHoldingMarker,
// isReasoningMarker, isInstructionMarker) each re-normalize the same line
// text in sequence while classifying a heading, so consecutive calls on an
// identical string are common during ingestion. Deterministic pure
// function, so caching only the most recent call is always correct — a
// cache miss just falls through to the normal computation.
let lastInput: string | undefined;
let lastResult: string | undefined;

/**
 * Collapse every spaced-letter run in `text` to its concatenated letters,
 * then normalize any resulting multi-spaces to a single space.
 */
export const collapseSpacedLetters = (text: string): string => {
  if (text === lastInput && lastResult !== undefined) {
    return lastResult;
  }
  const result = text
    .replace(spacedLetterRunRegex(), (match) => match.replace(SPACE_RE, ""))
    .replace(MULTI_SPACE_RE, " ");
  lastInput = text;
  lastResult = result;
  return result;
};
