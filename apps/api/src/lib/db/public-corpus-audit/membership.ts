import type { PgTable } from "drizzle-orm/pg-core";

import type * as schema from "../../../db/schema.ts";

type Schema = typeof schema;
type TableExport = {
  [Key in keyof Schema]: Schema[Key] extends PgTable ? Key : never;
}[keyof Schema];

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

export type PublicCorpusBookkeepingTable = {
  [Key in TableExport]: {
    schemaExport: Key;
    sqlName: Schema[Key] extends PgTable ? Schema[Key]["_"]["name"] : never;
    /** Canonical module defining this export; verified against the real table. */
    moduleId: `apps/api/src/db/schema/${string}`;
    /** Reviewed data semantics; SQL types cannot prove the provenance of values. */
    purpose: "public-corpus-bookkeeping";
    reason: string;
    /** Exhaustive SQL column names, each with its reviewed operational purpose. */
    columns: Readonly<Record<string, PublicCorpusColumn>>;
  };
}[TableExport];

// Admission belongs in the PR creating the table and its owner-only migration.
export const PUBLIC_CORPUS_BOOKKEEPING_TABLES: readonly PublicCorpusBookkeepingTable[] =
  [];
