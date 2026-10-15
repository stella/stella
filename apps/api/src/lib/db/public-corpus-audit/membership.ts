type PublicCorpusColumn = {
  kind:
    | "public-corpus-id"
    | "counter"
    | "timestamp"
    | "enum"
    | "parser-version"
    | "corpus-cursor";
  reason: string;
};

// Declarations document the tables admitted by the mutation lint rule.
export type PublicCorpusBookkeepingTable = {
  schemaExport: string;
  sqlName: string;
  /** Canonical module defining this export. */
  moduleId: `apps/api/src/db/schema/${string}`;
  /** Reviewed data semantics; SQL types cannot prove the provenance of values. */
  purpose: "public-corpus-bookkeeping";
  reason: string;
  /** Exhaustive SQL column names, each with its reviewed operational purpose. */
  columns: Readonly<Record<string, PublicCorpusColumn>>;
};

// Add a declaration in the PR creating the corresponding table.
export const PUBLIC_CORPUS_BOOKKEEPING_TABLES: readonly PublicCorpusBookkeepingTable[] =
  [];
