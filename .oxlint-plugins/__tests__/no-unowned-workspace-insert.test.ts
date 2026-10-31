import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { hasUnownedWorkspaceInsert } from "../sql/workspace-insert.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/api/src/lib/creator.test.ts",
) =>
  await lintSingleRule("no-unowned-workspace-insert", source, { sourcePath });

const hole = (expression: string) => `\${${expression}}`;

for (const { name, now, changedLines, reports } of [
  {
    name: "unchanged during rollout",
    now: "2026-10-31",
    changedLines: [],
    reports: false,
  },
  {
    name: "changed inside the insertion during rollout",
    now: "2026-10-31",
    changedLines: [3],
    reports: true,
  },
  {
    name: "unchanged after expiry",
    now: "2026-11-07",
    changedLines: [],
    reports: true,
  },
]) {
  test(`creation scope: ${name}`, async () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    const directory = await mkdtemp(
      path.join(repository, "node_modules/workspace-insert-rollout-"),
    );
    const wrapper = path.join(directory, "plugin.ts");
    const plugin = path.resolve(
      import.meta.dirname,
      "../no-unowned-workspace-insert.ts",
    );
    const scope = path.join(repository, "scripts/guard-rollouts.ts");
    const portablePath = path.join(
      repository,
      "packages/portable-path/src/index.ts",
    );
    await Bun.write(
      wrapper,
      `import { createWorkspaceInsertPlugin } from ${JSON.stringify(plugin)};
import { guardEnforcesLine } from ${JSON.stringify(scope)};
import { repoRelativePath } from ${JSON.stringify(portablePath)};
export default createWorkspaceInsertPlugin((options) => guardEnforcesLine({
  ...options,
  now: new Date(${JSON.stringify(now)}),
  changedLines: new Map([[repoRelativePath(${JSON.stringify(repository)}, options.file), new Set(${JSON.stringify(changedLines)})]]),
}));`,
    );
    try {
      await Promise.all(
        [
          {
            source:
              'import { workspaces } from "@/api/db/schema";\ntx.insert(workspaces).values({\n  visibility: "assigned_only",\n});',
            line: 2,
          },
          {
            source:
              "await tx.execute(sql`\n INSERT INTO workspaces (id, visibility)\n VALUES ($1, 'assigned_only');\n`);",
            line: 1,
          },
        ].flatMap(({ source, line }) => [
          lintSingleRule("no-unowned-workspace-insert", source, {
            sourcePath: "apps/api/src/lib/creator.test.ts",
            pluginPath: wrapper,
          }).then((diagnostics) =>
            expect(diagnostics).toEqual(reports ? [line] : []),
          ),
          lintSingleRule("no-unowned-workspace-insert", source, {
            sourcePath:
              ".oxlint-plugins/__fixtures__/no-unowned-workspace-insert.fixture.ts",
            pluginPath: wrapper,
          }).then((diagnostics) => expect(diagnostics).toEqual([line])),
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("the registered fixture proves both rejected and clean creation", async () => {
  const sourcePath =
    ".oxlint-plugins/__fixtures__/no-unowned-workspace-insert.fixture.ts";
  const source = readFileSync(
    new URL(
      "../__fixtures__/no-unowned-workspace-insert.fixture.ts",
      import.meta.url,
    ),
    "utf-8",
  );
  expect(await lint(source, sourcePath)).toEqual([]);
  expect(
    await lint(
      source.replaceAll(/\/\/ oxlint-disable-next-line[^\n]*\n/gu, ""),
      sourcePath,
    ),
  ).toHaveLength(1);
});

describe.serial("workspace inserts use the creation owner", () => {
  test("rejects private, missing and unknown row visibility in tests and seeds", async () => {
    const source = [
      'import { workspaces as matters } from "@/api/db/schema";',
      'import * as schema from "@/api/db/schema/contacts";',
      'tx.insert(matters).values({ visibility: "assigned_only" });',
      'tx["insert"](schema.workspaces).values({ name: "Missing" });',
      "const table = matters;",
      "tx.insert(table).values(rows);",
      "tx.insert(matters).values({ visibility: input.visibility });",
      'tx.insert(other).values({ visibility: "assigned_only" });',
      "const local = (matters) => tx.insert(matters).values({});",
    ].join("\n");
    expect(await lint(source)).toEqual([3, 4, 6, 7]);
    expect(await lint(source, "apps/api/scripts/seed-fixture.ts")).toEqual([
      3, 4, 6, 7,
    ]);
  });

  test("only inline rows with a final proven nonprivate visibility can bypass the owner", async () => {
    const source = [
      'import { workspaces } from "@/api/db/schema";',
      'import { MATTER_VISIBILITY as V } from "@stll/api-contract";',
      "const visibility = V.adminsAndAssigned;",
      "tx.insert(workspaces).values({ ...input, visibility });",
      'tx.insert(workspaces).values([{ visibility: "all_members" }, { visibility: V.adminsAndAssigned }]);',
      "tx.insert(workspaces).values(ids.map((id) => ({ id, visibility: V.allMembers })));",
      "tx.insert(workspaces).values({ visibility, ...input });",
      'tx.insert(workspaces).values({ visibility, [key]: "assigned_only" });',
      "const mutable = { visibility };",
      'mutable.visibility = "assigned_only";',
      "tx.insert(workspaces).values(mutable);",
    ].join("\n");
    expect(await lint(source)).toEqual([7, 8, 11]);
  });

  test("Array.from with an inline nonprivate projection proves every produced row", async () => {
    expect(
      await lint(
        [
          'import { workspaces } from "@/api/db/schema";',
          'import { MATTER_VISIBILITY } from "@stll/api-contract";',
          "await tx.insert(workspaces).values(Array.from({ length: count }, (_, id) => ({ id, visibility: MATTER_VISIBILITY.adminsAndAssigned })));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a bare prefix call does not admit a private insert", async () => {
    expect(
      await lint(
        [
          'import { workspaces } from "@/api/db/schema";',
          'await lockMatterStewardship({ tx, requests, mode: "update" });',
          'await tx.insert(workspaces).values({ visibility: "assigned_only" });',
        ].join("\n"),
      ),
    ).toEqual([3]);
  });

  test("the trusted callback must insert its normalized parameter", async () => {
    expect(
      await lint(
        [
          'import { workspaces } from "@/api/db/schema";',
          'import { withWorkspaceCreation as create } from "@/api/lib/workspaces/create-workspace-row";',
          "await create({ tx, rows, insert: async (normalized) => {",
          "  await tx.insert(workspaces).values(normalized);",
          "  await tx.insert(workspaces).values(rows);",
          '  await tx.insert(workspaces).values({ visibility: "assigned_only" });',
          "} });",
          "const createLocal = async ({ insert }) => insert(rows);",
          "await createLocal({ insert: async (normalized) => tx.insert(workspaces).values(normalized) });",
        ].join("\n"),
      ),
    ).toEqual([5, 6, 9]);
  });

  test("native callbacks bind the inserted identity from normalized rows", async () => {
    expect(
      await lint(
        [
          'import { withGatedWorkspaceCreation } from "@/api/tests/gated-test-database";',
          "await withGatedWorkspaceCreation({ tx, rows, insert: async (normalized) => {",
          "  const row = normalized.at(0);",
          `  await tx\`INSERT INTO workspaces (id, visibility) VALUES (${hole("row.id")}, ${hole("row.visibility")})\`;`,
          '  await tx.query("INSERT INTO workspaces (id, visibility) VALUES ($1, $2)", [row.id, row.visibility]);',
          `  await tx\`INSERT INTO workspaces (id, visibility) VALUES (${hole("unrelated.id")}, ${hole("unrelated.visibility")})\`;`,
          "  await tx`INSERT INTO workspaces (id, visibility) VALUES ('__normalized_id__', 'assigned_only')`;",
          "} });",
        ].join("\n"),
      ),
    ).toEqual([6, 7]);
  });

  test("native SQL uses visibility literals and proven binds, including comments and qualified tables", async () => {
    expect(
      await lint(
        [
          'import { MATTER_VISIBILITY } from "@stll/api-contract";',
          'await client.query("INSERT INTO public.workspaces (visibility) VALUES ($1)", [MATTER_VISIBILITY.adminsAndAssigned]);',
          `await client\`INSERT /* nested /* comment */ works */ INTO "workspaces" (visibility) VALUES (\${MATTER_VISIBILITY.allMembers})\`;`,
          "await client.query(\"INSERT INTO workspaces (visibility) VALUES ('assigned_only')\");",
          `await client\`INSERT INTO workspaces (name) VALUES (${hole("name")})\`;`,
          'await client.query("INSERT INTO workspaces (visibility) SELECT visibility FROM template");',
          "await client.query(\"SELECT 'INSERT INTO workspaces (visibility) VALUES (assigned_only)'\");",
        ].join("\n"),
      ),
    ).toEqual([4, 5, 6]);
  });

  test("native normalized identities survive checked element access and standard UUID casts", async () => {
    expect(
      await lint(
        [
          'import { panic } from "better-result";',
          'import { withPgliteWorkspaceCreation } from "@/api/tests/helpers/workspace-creation";',
          "await withPgliteWorkspaceCreation({ database, rows, insert: async (normalized) => {",
          'const row = normalized.at(0) ?? panic("Missing row");',
          'await database.query("INSERT INTO workspaces (id, visibility) VALUES ($1::uuid,$2)", [row.id, row.visibility]);',
          "} });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("SQL identifier helpers cannot hide the workspace table", async () => {
    const source = [
      'import { sql } from "drizzle-orm";',
      `await tx.execute(sql\`INSERT INTO \${sql.identifier("workspaces")} (visibility) VALUES ('assigned_only')\`);`,
      `await tx.execute(sql\`INSERT INTO \${sql.identifier("workspaces")} (visibility) VALUES ('all_members')\`);`,
    ].join("\n");
    expect(await lint(source)).toEqual([2]);
  });

  test("historical inserts require the runtime schema-proof helper and cannot state private visibility", async () => {
    const source = [
      'import { withLegacyWorkspaceFixture as legacy } from "@/api/tests/helpers/workspace-creation";',
      "await legacy({ tx, insert: async () => {",
      '  await tx.query("INSERT INTO workspaces (id) VALUES ($1)", [id]);',
      "  await tx.query(\"INSERT INTO workspaces (id,visibility) VALUES ($1,'assigned_only')\", [id]);",
      "} });",
      "const untrusted = async ({ insert }) => insert();",
      'await untrusted({ insert: async () => tx.query("INSERT INTO workspaces (id) VALUES ($1)", [id]) });',
    ].join("\n");
    expect(await lint(source)).toEqual([4, 7]);
    expect(await lint(source, "apps/api/scripts/seed-test.ts")).toEqual([
      3, 4, 7,
    ]);
  });

  test("only the concrete unproven INSERT refusal has an exception", async () => {
    const source =
      "test(\"an unsupported private INSERT is refused before deferred validation\", async () => { await database.query(\"INSERT INTO workspaces (id,organization_id,lead_user_id,visibility) VALUES ('00000000-0000-4000-8000-0000000000a9',$1,$2,'assigned_only')\", [org, lead]); });";
    expect(
      await lint(source, "apps/api/src/db/matter-steward-rollout.db.test.ts"),
    ).toEqual([]);
    expect(await lint(source)).toEqual([1]);
    expect(
      await lint(
        source.replace("0000000000a9", "0000000000aa"),
        "apps/api/src/db/matter-steward-rollout.db.test.ts",
      ),
    ).toEqual([1]);
  });

  test("the creation owner is the only unrestricted module", async () => {
    expect(
      await lint(
        'import { workspaces } from "@/api/db/schema"; tx.insert(workspaces).values(rows);',
        "apps/api/src/lib/workspaces/create-workspace-row.ts",
      ),
    ).toEqual([]);
  });
});

test("SQL classification covers every row and rejects incomplete or projected visibility", () => {
  for (const source of [
    "INSERT INTO workspaces (visibility) VALUES ('assigned_only')",
    "INSERT INTO workspaces (visibility) VALUES ('all_members'), ('assigned_only')",
    "INSERT INTO workspaces (visibility) VALUES ('all_members'); INSERT INTO workspaces (name) VALUES ('x')",
    "INSERT INTO workspaces (visibility) SELECT 'all_members'",
    'INSERT INTO "workspaces" DEFAULT VALUES',
  ]) {
    expect(hasUnownedWorkspaceInsert(source)).toBe(true);
  }
  expect(
    hasUnownedWorkspaceInsert(
      "SELECT 'INSERT INTO workspaces (visibility) VALUES (assigned_only)'",
    ),
  ).toBe(false);
  expect(
    hasUnownedWorkspaceInsert(
      "INSERT INTO workspaces (visibility) VALUES ('all_members'), ('admins_and_assigned')",
    ),
  ).toBe(false);
});
