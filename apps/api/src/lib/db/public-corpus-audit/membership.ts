export type PublicCorpusColumn = {
  kind:
    | "public-corpus-id"
    | "counter"
    | "timestamp"
    | "enum"
    | "parser-version"
    | "corpus-cursor";
  reason: string;
};

// The admission verifier binds declarations to the canonical schema without
// giving membership metadata access to protected table exports.
export type PublicCorpusBookkeepingTable = {
  schemaExport: string;
  sqlName: string;
  /** Canonical module defining this export; verified against the real table. */
  moduleId: `apps/api/src/db/schema/${string}`;
  /** Reviewed data semantics; SQL types cannot prove the provenance of values. */
  purpose: "public-corpus-bookkeeping";
  reason: string;
  /** Exhaustive SQL column names, each with its reviewed operational purpose. */
  columns: Readonly<Record<string, PublicCorpusColumn>>;
};

// Admission belongs in the PR creating the table and its owner-only migration.
export const PUBLIC_CORPUS_BOOKKEEPING_TABLES: readonly PublicCorpusBookkeepingTable[] =
  [];
