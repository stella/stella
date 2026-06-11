/**
 * Per-source license / redistribution descriptor for the legal corpus.
 *
 * Public legal sources (Slov-Lex, eSbírka, Polish Sejm, court portals)
 * carry materially different reuse terms. The corpus serves full text to
 * users and feeds it to AI, so redistribution and derived-AI permission
 * must be a typed, enforceable property of the source — not a comment.
 *
 * Stored on `caseLawSources.descriptor`. A `null` descriptor means a
 * legacy source predating this field; legacy court-decision sources are
 * treated as redistributable (they are public records), but new sources
 * should always carry an explicit descriptor.
 */

export const CORPUS_LICENSES = [
  "public-domain",
  "official-open-data",
  "cc-by",
  "cc-by-sa",
  "permitted-redistribution",
  "restricted",
] as const;

export type CorpusLicense = (typeof CORPUS_LICENSES)[number];

export type CorpusSourceDescriptor = {
  license: CorpusLicense;
  /** Attribution string to surface alongside results, or null if none required. */
  attribution: string | null;
  /** May full text be served to users / returned from search. */
  allowsRedistribution: boolean;
  /** May full text be fed to AI (query planning, reading, summarisation). */
  allowsDerivedAi: boolean;
};

/**
 * Whether a source's documents may be indexed into the searchable
 * projection and served. `null` (legacy) is permissive: existing
 * court-decision sources are public records.
 */
export const isRedistributable = (
  descriptor: CorpusSourceDescriptor | null | undefined,
): boolean =>
  descriptor === null ||
  descriptor === undefined ||
  descriptor.allowsRedistribution;

/** Whether a source's full text may be fed to the AI layer. */
export const allowsDerivedAi = (
  descriptor: CorpusSourceDescriptor | null | undefined,
): boolean =>
  descriptor === null || descriptor === undefined || descriptor.allowsDerivedAi;
