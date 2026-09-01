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
 * One collapse pass: join every spaced-letter run, then normalize any
 * resulting multi-spaces to a single space.
 *
 * A pass only ever deletes space characters, so it either leaves the
 * text alone or makes it strictly shorter. That is what bounds the loop
 * below.
 */
const collapsePass = (text: string): string =>
  text
    .replace(spacedLetterRunRegex(), (match) => match.replace(SPACE_RE, ""))
    .replace(MULTI_SPACE_RE, " ");

/**
 * Collapse every spaced-letter run in `text` to its concatenated letters,
 * normalizing multi-spaces to a single space.
 *
 * Applied to a fixpoint rather than once, so `f(f(x)) === f(x)` holds for
 * every input. A single pass did not settle: the pattern matches letters
 * separated by exactly one space, while the multi-space squeeze runs
 * afterwards, so a run written with two spaces survived the pass and came
 * out in the very shape the pattern was looking for. The next call then
 * collapsed what the previous one had not.
 *
 * That mattered because the two sides of a search comparison are folded
 * at different times — index time during ingestion, query time in the
 * case-viewer's find-in-page — and the query side is handed text the
 * index side already collapsed. A function that collapsed more on its
 * second application made those two sides disagree, which is exactly the
 * alignment this module exists to guarantee.
 *
 * Widening the pattern's separator to `+` would also settle it in one
 * pass, and is wrong: a single space separates the letters of one
 * emphasized word, and a wider gap separates two of them. Accepting both
 * as letter separators collapses `Ž a l o b a  s e  z a m í t á` to
 * `Žalobasezamítá` — the whole verdict as one word. The loop keeps that
 * distinction inside each pass.
 */
export const collapseSpacedLetters = (text: string): string => {
  if (text === lastInput && lastResult !== undefined) {
    return lastResult;
  }

  let result = text;
  for (;;) {
    const next = collapsePass(result);
    // Terminates: a pass that changes anything strictly shortens the
    // text, and a pass that changes nothing ends the loop.
    if (next === result) {
      break;
    }
    result = next;
  }

  lastInput = text;
  lastResult = result;
  return result;
};
