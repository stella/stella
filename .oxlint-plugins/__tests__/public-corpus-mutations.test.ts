import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  corpusDigest,
  verifyCorpusMigrations,
  verifiedCorpusMembership,
} from "../../apps/api/src/lib/db/public-corpus-audit/migration-verification.ts";
import { staticCorpusWriteTargets } from "../audit-on-mutation/public-corpus-mutations";
import { exactModuleId } from "../utils.ts";
import { lintSingleRule } from "./lint-single-rule";

const rulePath = path.resolve(
  import.meta.dir,
  "../require-audit-on-mutation.ts",
);
const table = {
  schemaExport: "databaseBackfillStates",
  sqlName: "database_backfill_states",
  moduleId: "apps/api/src/db/schema/backfill-state",
  purpose: "public-corpus-bookkeeping",
  reason: "Synthetic membership for resolver tests only",
  columns: {
    cursor: {
      kind: "corpus-cursor",
      reason:
        "Contains only a public publisher page number and never any tenant or user identifiers in this fixture",
    },
  },
};
const owner =
  "current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_backfill_states'::regclass)";
const migrations = [
  {
    file: "fixture.sql",
    sql: `CREATE TABLE public.database_backfill_states (cursor text);
ALTER TABLE public.database_backfill_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.database_backfill_states FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.database_backfill_states FROM stella, PUBLIC;
CREATE POLICY owner ON public.database_backfill_states FOR ALL TO PUBLIC USING (${owner}) WITH CHECK (${owner});`,
  },
];
const proof = {
  schemaExport: table.schemaExport,
  declarationDigest: corpusDigest(table),
  schemaDigest: "fixture",
  migrationDigest: corpusDigest(migrations),
  statementDigest: corpusDigest(
    verifyCorpusMigrations(table, migrations).relevant,
  ),
};
const members = verifiedCorpusMembership({
  entries: [table],
  attestations: [proof],
  migrations,
  schemaDigest: "fixture",
});

const prefix = [
  'import { databaseBackfillStates as checkpoint, workspaces } from "@/api/db/schema";',
  'import { sql } from "drizzle-orm";',
  "declare const db: { update: (table: unknown) => void; execute: (sql: unknown) => void };",
].join("\n");

const lint = async (body: string, imports = prefix) => {
  const directory = await mkdtemp(path.join(tmpdir(), "corpus-audit-fixture-"));
  const wrapper = path.join(directory, "plugin.ts");
  // Test-only membership injection; production has no configuration override.
  await Bun.write(
    wrapper,
    `import { createAuditOnMutationPlugin } from ${JSON.stringify(rulePath)};\nexport default createAuditOnMutationPlugin(() => ${JSON.stringify(members)});\n`,
  );
  try {
    return await lintSingleRule(
      "require-audit-on-mutation",
      `${imports}\nexport const write = () => { ${body} };\n`,
      {
        sourcePath: "apps/api/src/handlers/corpus-fixture.ts",
        pluginPath: wrapper,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe.serial("corpus mutation provenance", () => {
  test("exempts a proven renamed table import and immutable alias", async () => {
    expect(await lint("const table = checkpoint; db.update(table);")).toEqual(
      [],
    );
  });
  test("recognizes namespace and defining-module imports", async () => {
    expect(
      await lint(
        "db.update(tables.databaseBackfillStates);",
        'import * as tables from "@/api/db/schema";\ndeclare const db: { update: (table: unknown) => void };',
      ),
    ).toEqual([]);
    expect(
      await lint(
        "db.update(checkpoint);",
        'import { databaseBackfillStates as checkpoint } from "@/api/db/schema/backfill-state";\ndeclare const db: { update: (table: unknown) => void };',
      ),
    ).toEqual([]);
  });
  test("tenant and mixed writes still require an audit", async () => {
    expect(await lint("db.update(workspaces);")).toEqual([4]);
    expect(await lint("db.update(checkpoint); db.update(workspaces);")).toEqual(
      [4],
    );
  });
  test("dynamic, mutable, shadowed and re-exported targets are not exempt", async () => {
    expect(
      await lint("db.update(Math.random() ? checkpoint : workspaces);"),
    ).toEqual([4]);
    expect(
      await lint(
        "let table = checkpoint; table = workspaces; db.update(table);",
      ),
    ).toEqual([4]);
    expect(
      await lint("const checkpoint = workspaces; db.update(checkpoint);"),
    ).toEqual([4]);
    expect(
      await lint(
        "db.update(checkpoint);",
        'import { databaseBackfillStates as checkpoint } from "@/api/lib/re-export";\ndeclare const db: { update: (table: unknown) => void };',
      ),
    ).toEqual([3]);
  });
  test("module loaders cannot be shadowed and index files are distinct", async () => {
    expect(
      await lint(
        'const require = () => ({ databaseBackfillStates: workspaces }); db.update(require("@/api/db/schema").databaseBackfillStates);',
      ),
    ).toEqual([4]);
    expect(
      await lint(
        "db.update(checkpoint);",
        'import { databaseBackfillStates as checkpoint } from "@/api/db/schema/index.ts";\ndeclare const db: { update: (table: unknown) => void };',
      ),
    ).toEqual([3]);
    expect(
      await lint(
        'db.update(require("@/api/db/schema").databaseBackfillStates);',
      ),
    ).toEqual([]);
  });
  test("unproven table expressions remain audited", async () => {
    for (const body of [
      "const wrapper = (table: unknown) => table; db.update(wrapper(checkpoint));",
      "const tables = { checkpoint }; db.update(tables.checkpoint);",
      "const tables = { ...{ checkpoint } }; db.update(tables.checkpoint);",
      "const { databaseBackfillStates } = namespace; db.update(databaseBackfillStates);",
      "const writeTable = (table: unknown) => db.update(table); writeTable(checkpoint);",
    ]) {
      expect((await lint(body)).length).toBeGreaterThan(0);
    }
    expect(
      exactModuleId(
        "../db/schema.ts",
        "apps/api/src/handlers/corpus-fixture.ts",
      ),
    ).toBe("apps/api/src/db/schema");
    expect(await lint("db.insert(checkpoint); db.delete(checkpoint);")).toEqual(
      [],
    );
  });
  test("a builder reading another relation remains audited", async () => {
    for (const body of [
      "db.insert(checkpoint).select(db.select().from(workspaces));",
      "db.update(checkpoint).from(workspaces);",
      "const values = db.select().from(workspaces); db.update(checkpoint).set(values);",
      "db.update(checkpoint).set({ cursor: tenantValue() });",
      "const builder = db.update(checkpoint); builder.from(workspaces);",
    ]) {
      expect((await lint(body)).length).toBeGreaterThan(0);
    }
  });
  test("literal public payloads retain the verified exemption", async () => {
    expect(
      await lint("const cursor = 1; db.update(checkpoint).set({ cursor });"),
    ).toEqual([]);
  });
  test("mixed scopes retain existing audit and skip handling", async () => {
    expect(
      await lint(
        "db.update(checkpoint); db.update(workspaces); ctx.recordAuditEvent({});",
      ),
    ).toEqual([]);
    expect(
      await lint(
        "// audit: skip - existing explicitly reviewed write\ndb.update(checkpoint); db.update(workspaces);",
      ),
    ).toEqual([]);
  });
  test("raw static SQL requires every write target to be admitted", async () => {
    const dynamicTarget = ["$", "{checkpoint}"].join("");
    expect(
      await lint(
        "db.execute(sql`UPDATE public.database_backfill_states SET cursor = NULL`);",
      ),
    ).toEqual([]);
    expect(
      await lint(
        "db.execute(sql`UPDATE public.database_backfill_states SET cursor = NULL; DELETE FROM public.workspaces`);",
      ),
    ).toEqual([4]);
    expect(
      await lint(
        `db.execute(sql\`UPDATE ${dynamicTarget} SET cursor = NULL\`);`,
      ),
    ).toEqual([4]);
    expect(
      await lint(
        "db.execute(sql`UPDATE public.database_backfill_states SET cursor = NULL FROM public.workspaces`);",
      ),
    ).toEqual([4]);
  });
});

describe("static SQL exemption grammar", () => {
  test.each([
    "WITH changed AS (DELETE FROM public.workspaces) UPDATE public.checkpoint SET cursor = NULL",
    "UPDATE public.checkpoint SET cursor = dangerous()",
    "UPDATE\u00a0public.checkpoint SET cursor = NULL",
    "UPDATE public.checkpoint SET cursor = NULL -- comment",
    "UPDATE public.checkpoint SET cursor = NULL /* DELETE FROM public.workspaces */",
    "UPDATE checkpoint SET cursor = NULL",
    "UPDATE other.checkpoint SET cursor = NULL",
    "UPDATE public.checkpoint SET cursor = 'DELETE FROM workspaces'",
  ])("unsupported SQL remains audit-required: %s", (statement) => {
    expect(staticCorpusWriteTargets(statement)).toBeNull();
  });
  test("consumes all statements and folds unquoted names", () => {
    expect(
      staticCorpusWriteTargets(
        "UPDATE public.Checkpoint SET cursor = NULL; DELETE FROM public.receipt WHERE id = 1;",
      ),
    ).toEqual(["checkpoint", "receipt"]);
  });
});
