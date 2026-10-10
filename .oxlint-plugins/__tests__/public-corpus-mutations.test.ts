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
      `${imports}\nexport const write = async () => { ${body} };\n`,
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
  test("admits a completed direct write with a proven payload", async () => {
    expect(
      await lint(
        "const values = { cursor: 1 }; await db.update(checkpoint).set(values);",
      ),
    ).toEqual([]);
  });
  test("an unproven target retains the audit requirement", async () => {
    expect(
      await lint("await db.update(workspaces).set({ cursor: 1 });"),
    ).toEqual([4]);
  });
  test("a changed payload retains the audit requirement", async () => {
    expect(
      await lint(
        "const values = { cursor: 1 }; values.cursor = nextValue(); await db.update(checkpoint).set(values);",
      ),
    ).toEqual([4]);
  });
  test("a shared payload retains the audit requirement", async () => {
    expect(
      await lint(
        "const values = { cursor: 1 }; visit(values); await db.update(checkpoint).set(values);",
      ),
    ).toEqual([4]);
  });
  test("a stored builder retains the audit requirement", async () => {
    expect(
      await lint(
        "const builders = [db.update(checkpoint)]; builders[0].set({ cursor: nextValue() }); await builders[0];",
      ),
    ).toEqual([4]);
  });
  test("an explicitly executed returned write can be proven", async () => {
    expect(
      await lint("return db.update(checkpoint).set({ cursor: 1 }).execute();"),
    ).toEqual([]);
  });
  test("a static write resolves its admitted target", async () => {
    expect(
      await lint(
        "db.execute(sql`UPDATE public.database_backfill_states SET cursor = NULL`);",
      ),
    ).toEqual([]);
  });
});

describe("static SQL exemption grammar", () => {
  test("an unsupported expression requires an audit", () => {
    expect(
      staticCorpusWriteTargets(
        "UPDATE public.checkpoint SET cursor = nextValue()",
      ),
    ).toBeNull();
  });
  test("consumes statements and folds unquoted names", () => {
    expect(
      staticCorpusWriteTargets("UPDATE public.Checkpoint SET cursor = NULL;"),
    ).toEqual(["checkpoint"]);
  });
});
