import { describe, expect, test } from "bun:test";

import {
  corpusDigest,
  corpusSqlStatements,
  verifiedCorpusMembership,
  verifyCorpusMigrations,
} from "@/api/lib/db/public-corpus-audit/migration-verification";

const entry = {
  schemaExport: "checkpoint",
  sqlName: "checkpoint",
  moduleId: "apps/api/src/db/schema/checkpoint",
  purpose: "public-corpus-bookkeeping",
  reason: "Tracks a public corpus publisher crawl only",
  columns: {
    cursor: {
      kind: "counter",
      reason:
        "Counts public publisher pages already visited in this corpus crawl and contains no tenant identifiers or private values",
    },
  },
};
const owner =
  "current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.checkpoint'::regclass)";
const migrations = [
  {
    file: "first.sql",
    sql: `CREATE TABLE public.checkpoint (cursor integer);
ALTER TABLE public.checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkpoint FROM stella, PUBLIC;
CREATE POLICY owner ON public.checkpoint FOR ALL TO PUBLIC USING (${owner}) WITH CHECK (${owner});`,
  },
];
const proof = {
  schemaExport: entry.schemaExport,
  declarationDigest: corpusDigest(entry),
  schemaDigest: "schema",
  migrationDigest: corpusDigest(migrations),
  statementDigest: corpusDigest(
    verifyCorpusMigrations(entry, migrations).relevant,
  ),
};
const bundle = {
  entries: [entry],
  attestations: [proof],
  schemaDigest: "schema",
  migrations,
};

describe("committed corpus admission proof", () => {
  test("accepts a matching committed proof", () => {
    expect(verifyCorpusMigrations(entry, migrations).errors).toEqual([]);
    expect(verifiedCorpusMembership(bundle)).toHaveLength(1);
  });
  test("a changed schema requires a new proof", () => {
    expect(
      verifiedCorpusMembership({ ...bundle, schemaDigest: "changed" }),
    ).toEqual([]);
  });
  test("an unmatched migration retains the audit requirement", () => {
    const later = [
      ...migrations,
      {
        file: "later.sql",
        sql: "ALTER TABLE public.checkpoint ADD COLUMN label text",
      },
    ];
    expect(verifyCorpusMigrations(entry, later).errors.length).toBeGreaterThan(
      0,
    );
    expect(verifiedCorpusMembership({ ...bundle, migrations: later })).toEqual(
      [],
    );
  });
  test("quoted delimiters remain part of their statement", () => {
    expect(corpusSqlStatements("SELECT ';'; SELECT 2;")).toEqual([
      "SELECT ';'",
      "SELECT 2",
    ]);
  });
  test("an incomplete literal is rejected", () => {
    expect(corpusSqlStatements("SELECT 'unterminated")).toBeNull();
  });
});
