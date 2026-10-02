import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  reason: "Synthetic membership for resolver tests only",
  columns: {},
};
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
    `import { createAuditOnMutationPlugin } from ${JSON.stringify(rulePath)};\nexport default createAuditOnMutationPlugin(${JSON.stringify([table])});\n`,
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
