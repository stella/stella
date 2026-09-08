import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";

/**
 * What a source prints in a publisher field it has nothing to put in.
 *
 * A publisher that leaves a field empty and one that prints a sentence saying
 * the field is empty mean the same thing, but only the first reads as absent.
 * The second is text: long enough to clear any length threshold, stored like
 * any other value, and from there indistinguishable from a sentence the
 * publisher wrote about the decision. It is then indexed as a headnote, so it
 * boosts every row sharing its words, and shown to a reader as the sentence
 * the case is known by.
 *
 * The wording is the publisher's own, so a marker is declared per source, and
 * only ever as a sentence that source is observed to print — held to its
 * committed fixture by the test beside this module, never a sentence somebody
 * expects it to print.
 *
 * What a marker means is not per source: a sentence one court prints to say a
 * field is empty is not a headnote at any other court either, so
 * {@link sourceTextOrAbsent} compares against the whole list and is the only
 * place the mapping to absent happens. The operator repair for rows stored
 * before an adapter read the list reads the same declarations.
 */
type SourceAbsentText = {
  /** The source observed to print it. */
  readonly adapter: AdapterKey;
  /** The sentence, exactly as the source prints it. */
  readonly text: string;
};

export const SOURCE_ABSENT_TEXT = [
  /**
   * NALUS serves the abstract and the legal sentence of a decision as one
   * page, and prints these in the cell the text itself would occupy where it
   * holds neither — one sentence per field, naming the field it stands in for.
   */
  { adapter: ADAPTER_KEYS.CZ_US, text: "Abstrakt není k dispozici." },
  { adapter: ADAPTER_KEYS.CZ_US, text: "Právní věta není k dispozici." },
] as const satisfies readonly SourceAbsentText[];

/**
 * The form a marker comparison is made in: whitespace runs collapsed, then
 * trimmed. The value a source publishes keeps its own whitespace — collapsing
 * it would rewrite every real headnote in the corpus — so this is how two
 * texts are compared, never what is stored.
 *
 * The repair's SQL makes the same reading as
 * `btrim(regexp_replace(value, '\s+', ' ', 'g'))`, and its database test holds
 * the two readings to the same answer.
 */
export const absentTextComparison = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

/** Every declared marker, in comparison form, for a reader outside TypeScript. */
export const SOURCE_ABSENT_TEXT_COMPARISONS = SOURCE_ABSENT_TEXT.map(
  ({ text }) => absentTextComparison(text),
);

const ABSENT_COMPARISONS = new Set(SOURCE_ABSENT_TEXT_COMPARISONS);

/**
 * One publisher field as an adapter should store it: the text the source
 * printed, or nothing at all where what it printed was a declared marker or
 * no text. An adapter writes the result straight through, so a field the
 * source left empty and a field it filled with its own "not available"
 * sentence reach the row as the same absence.
 */
export const sourceTextOrAbsent = (raw: string): string | undefined => {
  const text = raw.trim();
  if (text.length === 0 || ABSENT_COMPARISONS.has(absentTextComparison(text))) {
    return undefined;
  }
  return text;
};
