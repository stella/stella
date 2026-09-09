import type { AdapterKey } from "@/api/handlers/case-law/consts";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";

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
 * A marker belongs to the source that prints it, and reading it as absence is
 * scoped to that source in both directions. The wording is one publisher's:
 * another may put the same words in a field it means, and a source whose
 * adapter does not read the list would have the sentence written straight back
 * on the next crawl, so a repair that stripped it would never reach a fixed
 * point. Declaring a marker for an adapter and reading that adapter's fields
 * through {@link sourceTextOrAbsent} are therefore one step, not two.
 *
 * A marker is only ever a sentence its source is observed to print — held to
 * that source's committed fixture by the test beside this module, never a
 * sentence somebody expects it to print.
 */
export const SOURCE_ABSENT_TEXT = Object.values(ADAPTER_MANIFESTS).flatMap(
  ({ key: adapter, placeholderPatterns }) =>
    placeholderPatterns.map(({ text }) => ({ adapter, text })),
);

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

/**
 * One adapter's markers, in comparison form, for a reader outside TypeScript.
 * Empty for an adapter that declares none, which is every adapter whose source
 * fills an empty field with nothing.
 */
export const absentTextComparisonsFor = (
  adapter: AdapterKey,
): readonly string[] =>
  SOURCE_ABSENT_TEXT.filter((marker) => marker.adapter === adapter).map(
    ({ text }) => absentTextComparison(text),
  );

/** Every adapter that declares at least one marker. */
export const ADAPTERS_DECLARING_ABSENT_TEXT: readonly AdapterKey[] = [
  ...Object.values(ADAPTER_MANIFESTS)
    .filter(({ placeholderPatterns }) => placeholderPatterns.length > 0)
    .map(({ key }) => key),
];

const COMPARISONS_BY_ADAPTER = new Map<AdapterKey, ReadonlySet<string>>(
  ADAPTERS_DECLARING_ABSENT_TEXT.map((adapter) => [
    adapter,
    new Set(absentTextComparisonsFor(adapter)),
  ]),
);

/**
 * One publisher field as the adapter reading it should store it: the text the
 * source printed, or nothing at all where what it printed was one of that
 * source's markers or no text. The adapter writes the result straight through,
 * so a field the source left empty and a field it filled with its own "not
 * available" sentence reach the row as the same absence.
 */
export const sourceTextOrAbsent = (
  adapter: AdapterKey,
  raw: string,
): string | undefined => {
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }
  return COMPARISONS_BY_ADAPTER.get(adapter)?.has(
    absentTextComparison(text),
  ) === true
    ? undefined
    : text;
};
