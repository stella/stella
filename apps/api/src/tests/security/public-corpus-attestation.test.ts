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
  test("requires all migration controls before an attestation can match", () => {
    expect(verifyCorpusMigrations(entry, migrations).errors).toEqual([]);
    expect(verifiedCorpusMembership(bundle)).toHaveLength(1);
    for (const control of [
      "FORCE ROW LEVEL SECURITY",
      "ENABLE ROW LEVEL SECURITY",
      "REVOKE ALL",
      "CREATE POLICY",
    ]) {
      const removed = migrations.map(({ file, sql }) => ({
        file,
        sql:
          corpusSqlStatements(sql)
            ?.filter((statement) => !statement.includes(control))
            .join(";") ?? "",
      }));
      expect(
        verifyCorpusMigrations(entry, removed).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  test("missing or stale proofs retain the audit requirement", () => {
    expect(verifiedCorpusMembership({ ...bundle, attestations: [] })).toEqual(
      [],
    );
    expect(
      verifiedCorpusMembership({ ...bundle, schemaDigest: "changed" }),
    ).toEqual([]);
    expect(
      verifiedCorpusMembership({
        ...bundle,
        entries: [
          { ...entry, reason: "Changed semantics require a new review" },
        ],
      }),
    ).toEqual([]);
    expect(
      verifiedCorpusMembership({
        ...bundle,
        migrations: [...migrations, { file: "later.sql", sql: "SELECT 1;" }],
      }),
    ).toEqual([]);
    expect(
      verifiedCorpusMembership({
        ...bundle,
        attestations: [{ ...proof, statementDigest: "changed" }],
      }),
    ).toEqual([]);
  });
  test.each([
    "GRANT SELECT ON public.checkpoint TO stella",
    "GRANT SELECT ON public.CHECKPOINT TO stella",
    'GRANT SELECT ON U&"public".U&"chec\\006bpoint" TO stella',
    "GRANT SELECT (cursor) ON public.checkpoint TO stella",
    "GRANT SELECT ON public.checkpoint TO PUBLIC",
    "GRANT SELECT ON public.checkpoint TO another_role",
    "GRANT another_role TO stella",
    "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO stella",
    "ALTER TABLE public.checkpoint ADD COLUMN owner_id uuid",
    "ALTER TABLE public.checkpoint DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.checkpoint NO FORCE ROW LEVEL SECURITY",
    "CREATE POLICY extra ON public.checkpoint FOR ALL TO PUBLIC USING (true) WITH CHECK (true)",
    "CREATE TRIGGER extra AFTER INSERT ON public.checkpoint EXECUTE FUNCTION tenant_write()",
    "CREATE TABLE public.tenant (organization_id uuid, parent integer REFERENCES public.checkpoint(cursor))",
    "CREATE VIEW public.visible AS SELECT * FROM public.checkpoint",
    "CREATE FUNCTION public.visible() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT cursor FROM public.checkpoint $$",
    "DO $$ BEGIN EXECUTE 'ALTER TABLE ' || 'public.' || 'checkpoint DISABLE ROW LEVEL SECURITY'; END $$",
    "ALTER TABLE public.child INHERIT public.checkpoint",
    "CREATE RULE extra AS ON UPDATE TO public.checkpoint DO ALSO SELECT 1",
  ])("later unsupported statement cannot be re-attested: %s", (sql) => {
    const later = [...migrations, { file: "later.sql", sql }];
    expect(verifyCorpusMigrations(entry, later).errors.length).toBeGreaterThan(
      0,
    );
    expect(verifiedCorpusMembership({ ...bundle, migrations: later })).toEqual(
      [],
    );
  });
  test("an earlier routine or global privilege change cannot escape the proof", () => {
    for (const sql of [
      "DO $$ BEGIN EXECUTE 'ALTER DEFAULT ' || 'PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'; END $$",
      "CREATE FUNCTION public.later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT * FROM ' || 'public.checkpoint'; END $$",
      "GRANT pg_read_all_data TO stella",
    ]) {
      expect(
        verifyCorpusMigrations(entry, [
          { file: "earlier.sql", sql },
          ...migrations,
        ]).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  test("quoted bodies, literals and nested comments cannot hide statements", () => {
    expect(
      corpusSqlStatements(
        "SELECT ';'; /* outer /* inner */ */ SELECT 2; DO $$ BEGIN SELECT 3; END $$;",
      ),
    ).toEqual(["SELECT ';'", "SELECT 2", "DO $$ BEGIN SELECT 3; END $$"]);
    expect(corpusSqlStatements("SELECT 'unterminated")).toBeNull();
    expect(corpusSqlStatements("/* unterminated")).toBeNull();
  });
});
