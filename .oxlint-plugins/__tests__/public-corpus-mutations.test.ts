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
const members = [table];

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
  test("an opaque computed key retains the audit requirement", async () => {
    expect(
      await lint(
        "await db.update(checkpoint).set({ cursor: checkpoint[resolveKey()] });",
      ),
    ).toEqual([4]);
  });
  test("a changed SQL value retains the audit requirement", async () => {
    expect(
      await lint(
        "const query = sql`UPDATE public.database_backfill_states SET cursor = NULL`; query.append(otherSql); db.execute(query);",
      ),
    ).toEqual([4]);
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
