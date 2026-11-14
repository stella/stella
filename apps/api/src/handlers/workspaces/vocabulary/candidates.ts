import * as v from "valibot";

export const VOCABULARY_KINDS = [
  "matter-name",
  "party",
  "person",
  "organization",
  "case-number",
  "court",
  "document-title",
  "statute",
  "decision",
  "glossary",
] as const;

export type VocabularyKind = (typeof VOCABULARY_KINDS)[number];

export const VOCABULARY_WEIGHTS = {
  "matter-name": 1,
  party: 1,
  person: 0.9,
  organization: 0.9,
  "case-number": 0.8,
  court: 0.8,
  "document-title": 0.6,
  statute: 0.7,
  decision: 0.7,
  glossary: 1,
} as const satisfies Record<VocabularyKind, number>;

export const VOCABULARY_LIMITS = {
  perKind: 32,
  total: 128,
  termLength: 512,
  contacts: 64,
} as const;

export type VocabularySource = {
  term: string;
  kind: VocabularyKind;
  lastUsedAt?: Date | undefined;
};

// This is a bounded vocabulary sample, not a paginated directory. Oversized
// terms are omitted whole: truncating a name would invent a different term.
export const collectVocabulary = (sources: readonly VocabularySource[]) => {
  const unique = new Map<string, VocabularySource>();
  for (const source of sources) {
    const term = source.term.trim();
    if (term.length === 0 || term.length > VOCABULARY_LIMITS.termLength) {
      continue;
    }
    const key = JSON.stringify([source.kind, term]);
    const previous = unique.get(key);
    if (
      previous === undefined ||
      (source.lastUsedAt?.getTime() ?? 0) >
        (previous.lastUsedAt?.getTime() ?? 0)
    ) {
      unique.set(key, { ...source, term });
    }
  }
  const counts = new Map<VocabularyKind, number>();
  return [...unique.values()]
    .toSorted(
      (left, right) =>
        VOCABULARY_WEIGHTS[right.kind] - VOCABULARY_WEIGHTS[left.kind] ||
        (right.lastUsedAt?.getTime() ?? 0) - (left.lastUsedAt?.getTime() ?? 0),
    )
    .filter(({ kind }) => {
      const count = counts.get(kind) ?? 0;
      counts.set(kind, count + 1);
      return count < VOCABULARY_LIMITS.perKind;
    })
    .slice(0, VOCABULARY_LIMITS.total)
    .map((source) => ({ ...source, weight: VOCABULARY_WEIGHTS[source.kind] }));
};

export const vocabularyResponseSchema = v.object({
  candidates: v.pipe(
    v.array(
      v.object({
        term: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(VOCABULARY_LIMITS.termLength),
        ),
        kind: v.picklist(VOCABULARY_KINDS),
        weight: v.number(),
        lastUsedAt: v.optional(v.date()),
      }),
    ),
    v.maxLength(VOCABULARY_LIMITS.total),
  ),
});
