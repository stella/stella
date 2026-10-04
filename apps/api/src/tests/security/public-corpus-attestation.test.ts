import { PGlite } from "@electric-sql/pglite";
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
  test.each(["stella", "PUBLIC"])(
    "accepts separate single-role revokes beginning with %s",
    (firstRole) => {
      const otherRole = firstRole === "stella" ? "PUBLIC" : "stella";
      const separate = migrations.map(({ file, sql }) => {
        const combined = "REVOKE ALL ON public.checkpoint FROM stella, PUBLIC;";
        expect(sql).toContain(combined);
        return {
          file,
          sql: sql.replace(
            combined,
            () =>
              `REVOKE ALL ON public.checkpoint FROM ${firstRole};\nREVOKE ALL ON public.checkpoint FROM ${otherRole};`,
          ),
        };
      });
      expect(verifyCorpusMigrations(entry, separate).errors).toEqual([]);
      const matched = {
        ...proof,
        migrationDigest: corpusDigest(separate),
        statementDigest: corpusDigest(
          verifyCorpusMigrations(entry, separate).relevant,
        ),
      };
      expect(
        verifiedCorpusMembership({
          ...bundle,
          migrations: separate,
          attestations: [matched],
        }),
      ).toHaveLength(1);
    },
  );

  test.each([
    String.raw`SELECT 'left\'; SELECT 'right'; SELECT '--';`,
    String.raw`SELECT "left\"; SELECT "right";`,
    String.raw`SELECT nameE'left\'; SELECT 'right';`,
    String.raw`SELECT name$E'left\'; SELECT 'right';`,
    String.raw`SELECT caféE'left\'; SELECT 'right';`,
  ])("rejects ambiguous quoted backslashes: %s", (source) => {
    expect(corpusSqlStatements(source)).toBeNull();
    expect(
      verifyCorpusMigrations(entry, [
        ...migrations,
        { file: "literal.sql", sql: source },
      ]).errors,
    ).toContain("literal.sql: unsupported migration quoting");
  });

  test("accepts only setting-independent quoted backslashes", async () => {
    const database = new PGlite();
    try {
      const ordinary = String.raw`SELECT 'left\\right' AS value`;
      const escaped = String.raw`SELECT E'left\\right' AS value`;
      await database.exec("SET standard_conforming_strings = on");
      const standard = await database.query(ordinary);
      const standardEscape = await database.query(escaped);
      await database.exec("SET standard_conforming_strings = off");
      const legacy = await database.query(ordinary);
      const legacyEscape = await database.query(escaped);
      expect(standard.rows).not.toEqual(legacy.rows);
      expect(standardEscape.rows).toEqual(legacyEscape.rows);
      expect(corpusSqlStatements(ordinary)).toBeNull();
      expect(corpusSqlStatements(`${escaped}; SELECT 2;`)).toEqual([
        escaped,
        "SELECT 2",
      ]);
    } finally {
      await database.close();
    }
  });

  test.each([
    String.raw`SELECT E'left\';right'`,
    String.raw`SELECT e'left\\'; SELECT 2`,
    String.raw`SELECT E'left''right'`,
  ])("keeps explicit escape strings intact: %s", (source) => {
    const statements = corpusSqlStatements(`${source}; SELECT 3;`);
    const expected = source.endsWith("; SELECT 2")
      ? [source.slice(0, -"; SELECT 2".length), "SELECT 2", "SELECT 3"]
      : [source, "SELECT 3"];
    expect(statements).toEqual(expected);
  });

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
