/**
 * One shape for every value an agent spells its own way.
 *
 * Models copy examples, translate, and reach for the notation their training
 * data used most: a date arrives as `1. 10. 2026`, a number as `4 000`, a
 * boolean as `ano`, a locale as `cs_CZ`. Each kind in this directory reads the
 * spellings that carry one meaning and asks for a fix when a spelling carries
 * two, so no call site grows its own parser or its own wording.
 *
 * `ok: true` is the canonical value, with `note` set when the input had to be
 * read rather than taken verbatim (surface it as a warning, never as an
 * error). `ok: false` is the single ask-for-a-fix shape: `expected` names the
 * canonical form and `hint` names the one call to make. Callers render those
 * two rather than composing wording of their own, which is what keeps one kind
 * answering the same way on every surface.
 */

/** The one ask-for-a-fix shape. */
export type NormalizedAsk = {
  ok: false;
  /** The input as the agent sent it, quoted and bounded. */
  received: string;
  /** The canonical form as a noun phrase: "a calendar date". */
  expected: string;
  /** The corrective call, spelled out. */
  hint: string;
};

export type Normalized<TValue> =
  | { ok: true; value: TValue; note?: string }
  | NormalizedAsk;

/** Wire values carry matter content and personal data, so an echo back to the
 *  model is bounded to the length of a spelling. */
const MAX_RECEIVED_CHARS = 80;

/** The input as one quoted token: what the agent sent, ready to drop into a
 *  sentence. */
const describeInput = (input: unknown): string => {
  // A function or a symbol has no JSON spelling, so it is named by its type
  // rather than stringified into "[object Object]".
  const spelled =
    typeof input === "function" || typeof input === "symbol"
      ? undefined
      : JSON.stringify(input);
  const rendered =
    input === undefined ? "undefined" : (spelled ?? `a ${typeof input}`);
  return rendered.length <= MAX_RECEIVED_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_RECEIVED_CHARS)}…`;
};

export const readValue = <TValue>(value: TValue): Normalized<TValue> => ({
  ok: true,
  value,
});

/**
 * The canonical value, plus the "read X as Y" note when the agent's spelling
 * was not already the canonical one. That sentence is spelled here alone, so
 * every kind reports a coercion the same way. `canonical` overrides how the
 * result is rendered in the note, for a kind whose canonical spelling is not
 * the JSON form of its value.
 */
export const readValueAs = <TValue>(
  input: unknown,
  value: TValue,
  canonical: string = describeInput(value),
): Normalized<TValue> => {
  const received = describeInput(input);
  return received === canonical
    ? { ok: true, value }
    : { ok: true, value, note: `Read ${received} as ${canonical}.` };
};

export const askForFix = ({
  input,
  expected,
  hint,
}: {
  input: unknown;
  expected: string;
  hint: string;
}): NormalizedAsk => ({
  ok: false,
  received: describeInput(input),
  expected,
  hint,
});

/** The ask as one sentence, for a caller whose issue shape carries a message
 *  beside the hint. */
export const askSentence = (ask: NormalizedAsk): string =>
  `${ask.received} is not ${ask.expected}.`;
