/**
 * Legal-vocabulary alternatives for a case-law search: per word the reader
 * typed, the words the jurisdiction's statutes and courts use for the same
 * thing ("kauce" → "jistota"). A model proposes them per query (see
 * `handlers/case-law/decisions/search-expand.ts`); everything here is the pure
 * part, shared by the endpoint that asks the model and the search that
 * receives the answer, so both apply one rule to what an alternative may be.
 *
 * Alternatives only ever add recall. The reader's own word stays in its OR
 * group, and a word the rules below reject simply gets no alternative.
 */

import { type Static, t } from "elysia";

import {
  type CorpusTermExpander,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import {
  type ExpansionDictionaryIdentity,
  serializeExpansionDictionaryIdentity,
} from "@/api/lib/legal-search/morphology/dictionary";
import { functionWordKey } from "@/api/lib/legal-search/morphology/function-words";

/**
 * Bounds on one query's alternatives. Each alternative costs a surface leaf
 * plus its stem leaves inside the corpus query's leaf budget, so the bound is
 * what keeps a model answer from crowding out the query's own stems.
 */
export const LEGAL_ALTERNATIVES_LIMITS = {
  /** Words of one query that may carry alternatives. */
  terms: 6,
  /** Alternatives per word. */
  perTerm: 3,
  /** Words in one alternative; a short statutory phrase at most. */
  words: 3,
  /** Characters in one word or alternative on the wire. */
  chars: 64,
} as const;

export const tLegalAlternatives = t.Array(
  t.Object(
    {
      term: t.String({
        minLength: 1,
        maxLength: LEGAL_ALTERNATIVES_LIMITS.chars,
      }),
      alternatives: t.Array(
        t.String({ minLength: 1, maxLength: LEGAL_ALTERNATIVES_LIMITS.chars }),
        { maxItems: LEGAL_ALTERNATIVES_LIMITS.perTerm },
      ),
    },
    { additionalProperties: false },
  ),
  { maxItems: LEGAL_ALTERNATIVES_LIMITS.terms },
);

export type LegalAlternatives = Static<typeof tLegalAlternatives>;

type NormalizeLegalAlternativesOptions = {
  /** The reader's query, whose words alone may carry alternatives. */
  query: string;
  /** The function words the search drops, which never get alternatives. */
  functionWords: ReadonlySet<string> | null;
};

/**
 * Alternatives reduced to the ones the search can use, in one canonical form.
 *
 * Applied to what the model returns and again to what a search request
 * carries, because the second arrives from a client: only a word the search
 * will require (a term, not a phrase, not a dropped function word) keeps
 * alternatives; an alternative must tokenize to one to
 * {@link LEGAL_ALTERNATIVES_LIMITS.words} words and differ from the word it
 * stands beside; duplicates collapse; every bound is enforced. Terms keep the
 * query's order, so equal input always yields an equal answer.
 */
export const normalizeLegalAlternatives = (
  proposed: readonly { term: string; alternatives: readonly string[] }[],
  { functionWords, query }: NormalizeLegalAlternativesOptions,
): LegalAlternatives => {
  const { required } = partitionCorpusFunctionWords(
    tokenizeCorpusFreeText(query),
    functionWords,
  );
  const expandable = new Map<string, string>();
  for (const token of required) {
    if (token.type === "term") {
      expandable.set(functionWordKey(token.value), token.value);
    }
  }

  const byKey = new Map<string, string[]>();
  for (const entry of proposed) {
    const key = functionWordKey(corpusTokens(entry.term).join(" "));
    if (!expandable.has(key)) {
      continue;
    }
    const kept = byKey.get(key) ?? [];
    for (const alternative of entry.alternatives) {
      const words = corpusTokens(alternative);
      if (words.length === 0 || words.length > LEGAL_ALTERNATIVES_LIMITS.words) {
        continue;
      }
      const normalized = functionWordKey(words.join(" "));
      if (
        normalized === key ||
        normalized.length > LEGAL_ALTERNATIVES_LIMITS.chars ||
        kept.includes(normalized) ||
        kept.length >= LEGAL_ALTERNATIVES_LIMITS.perTerm
      ) {
        continue;
      }
      kept.push(normalized);
    }
    byKey.set(key, kept);
  }

  const alternatives: LegalAlternatives = [];
  for (const [key, term] of expandable) {
    const kept = byKey.get(key);
    if (kept === undefined || kept.length === 0) {
      continue;
    }
    if (alternatives.length >= LEGAL_ALTERNATIVES_LIMITS.terms) {
      break;
    }
    alternatives.push({ term, alternatives: kept });
  }
  return alternatives;
};

/**
 * The alternatives as the query builder reads them, or null when there are
 * none, which leaves the query byte for byte what it was without them.
 */
export const legalAlternativesExpander = (
  alternatives: LegalAlternatives,
): CorpusTermExpander | null => {
  if (alternatives.length === 0) {
    return null;
  }
  const byKey = new Map(
    alternatives.map((entry) => [
      functionWordKey(entry.term),
      entry.alternatives,
    ]),
  );
  return (term) => byKey.get(functionWordKey(term)) ?? [];
};

/**
 * The identity a corpus cursor pins when a query carried alternatives.
 *
 * The alternatives are part of the ranking, so a continuation asked with
 * different ones must be refused the way one built against another expansion
 * dictionary is. Both answers fold into the one content hash the cursor
 * already carries, which is why this returns that identity type rather than a
 * second cursor field: a page built with no alternatives keeps the identity it
 * always had.
 */
export const withLegalAlternativesIdentity = (
  dictionary: ExpansionDictionaryIdentity,
  alternatives: LegalAlternatives,
): ExpansionDictionaryIdentity => {
  if (alternatives.length === 0) {
    return dictionary;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serializeExpansionDictionaryIdentity(dictionary));
  hasher.update("\u0000");
  hasher.update(JSON.stringify(alternatives));
  return { contentHash: hasher.digest("hex"), type: "dictionary" };
};
