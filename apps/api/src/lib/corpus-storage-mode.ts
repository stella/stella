/**
 * Where a legal-corpus document's canonical payload (text, sections, AST)
 * lives.
 *
 * - `off`        Postgres columns only; object storage is never touched.
 * - `dual-write` Postgres columns stay authoritative; ingestion mirrors the
 *                payload to object storage and reads prefer the objects.
 * - `canonical`  Object storage is authoritative; a newly written row keeps
 *                only the object keys and content hash, and its
 *                text/sections/AST columns stay NULL.
 *
 * Resolved once in `env-base`; every consumer reads that single value.
 */
export const CORPUS_STORAGE_MODES = ["off", "dual-write", "canonical"] as const;

export type CorpusStorageMode = (typeof CORPUS_STORAGE_MODES)[number];

type ResolveCorpusStorageModeInput = {
  mode: CorpusStorageMode | undefined;
  /** Legacy `CORPUS_STORAGE_ENABLED`; still accepted, still means dual-write. */
  legacyEnabled: boolean;
};

export const resolveCorpusStorageMode = ({
  mode,
  legacyEnabled,
}: ResolveCorpusStorageModeInput): CorpusStorageMode =>
  mode ?? (legacyEnabled ? "dual-write" : "off");

type CorpusStorageInvariantInput = {
  mode: CorpusStorageMode;
  /**
   * Mirrors LEGAL_SEARCH_ENGINES. Spelled out rather than imported so this
   * module stays a leaf: `env-base` imports it, and pulling in the
   * legal-search types from here would drag the whole search/db graph into
   * every project that typechecks `env-base`. A new engine widens
   * LEGAL_SEARCH_PROVIDER and fails at the call site, so it cannot drift
   * silently.
   */
  searchProvider: "pg-fts" | "corpus-index";
  corpusIndexingEnabled: boolean;
  corpusBucket: string | undefined;
  isDev: boolean;
};

/**
 * Cross-field configuration invariants the per-field env schema cannot
 * express. Returns the violated invariant's message, or null when the
 * configuration is coherent.
 */
export const corpusStorageInvariantViolation = ({
  mode,
  searchProvider,
  corpusIndexingEnabled,
  corpusBucket,
  isDev,
}: CorpusStorageInvariantInput): string | null => {
  if (mode === "off") {
    return null;
  }

  // A canonical row is never given a Postgres tsvector, so the pg-fts
  // provider has nothing to match it against and the document would be
  // invisible to search the moment it is ingested.
  if (mode === "canonical" && searchProvider !== "corpus-index") {
    return (
      "CORPUS_STORAGE_MODE=canonical requires LEGAL_SEARCH_PROVIDER=corpus-index: " +
      "canonical rows carry no Postgres tsvector for pg-fts to serve"
    );
  }

  // The corpus index is the only projection a canonical row can appear in,
  // and the indexer loop is what fills it. Without that loop running, a
  // newly ingested decision reaches no search projection at all.
  if (mode === "canonical" && !corpusIndexingEnabled) {
    return (
      "CORPUS_STORAGE_MODE=canonical requires CORPUS_INDEXING_ENABLED=true: " +
      "nothing else indexes a canonical row, so it would never become searchable"
    );
  }

  // In deployed envs the corpus must use its own bucket, not the default
  // document bucket (it falls back to S3_BUCKET only for local dev).
  if (!isDev && corpusBucket === undefined) {
    return `CORPUS_STORAGE_MODE=${mode} requires LEGAL_CORPUS_S3_BUCKET in deployed environments`;
  }

  return null;
};
