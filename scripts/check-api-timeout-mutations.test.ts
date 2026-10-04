import { expect, test } from "bun:test";

import {
  checkApiTimeoutMutations,
  findApiTimeoutMutations,
  isTimeoutMutationSource,
} from "./check-api-timeout-mutations.ts";

const FILE = "apps/api/src/handlers/example.ts";
const settingExpression = ["$", "{setting}"].join("");
const budgetExpression = ["$", "{budget}"].join("");
const names = (source: string) =>
  findApiTimeoutMutations(FILE, source).map(({ setting }) => setting);

test.each([
  [
    "local zero",
    "await tx.execute(sql`SET LOCAL statement_timeout = 0`);",
    "statement_timeout",
  ],
  [
    "session to",
    "await tx.execute(sql`SET SESSION statement_timeout TO '30s'`);",
    "statement_timeout",
  ],
  [
    "quoted session setting",
    'await tx.execute(sql`SET SESSION "statement_timeout" TO DEFAULT`);',
    "statement_timeout",
  ],
  [
    "default",
    "await tx.execute(sql`SET statement_timeout TO DEFAULT`);",
    "statement_timeout",
  ],
  [
    "reset",
    "await tx.execute(sql`RESET statement_timeout`);",
    "statement_timeout",
  ],
  [
    "quoted reset setting",
    'await tx.execute(sql`RESET "lock_timeout"`);',
    "lock_timeout",
  ],
  ["reset all", "await tx.execute(sql`RESET ALL`);", "dynamic timeout setting"],
  [
    "SQL comment before reset",
    "await tx.execute(sql`-- reason\nRESET statement_timeout`);",
    "statement_timeout",
  ],
  [
    "lock",
    "await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);",
    "lock_timeout",
  ],
  [
    "idle",
    "await tx.execute(sql`SET idle_in_transaction_session_timeout = '1min'`);",
    "idle_in_transaction_session_timeout",
  ],
  [
    "raw SQL",
    "await tx.execute(sql.raw('SET statement_timeout = 0'));",
    "statement_timeout",
  ],
  [
    "plain SQL",
    "await connection.execute('SET statement_timeout TO DEFAULT');",
    "statement_timeout",
  ],
  [
    "concatenated SQL",
    "await connection.execute('SET ' + 'statement_timeout = 0');",
    "statement_timeout",
  ],
  [
    "dynamic concatenated setting",
    "await connection.execute('SET ' + setting + ' = 0');",
    "dynamic timeout setting",
  ],
  [
    "interpolated SQL",
    `await connection.execute(\`SET statement_timeout = '${budgetExpression}'\`);`,
    "statement_timeout",
  ],
  [
    "set_config",
    "await tx.execute(sql`SELECT set_config('statement_timeout', '0', true)`);",
    "statement_timeout",
  ],
  [
    "quoted set_config name",
    "await tx.execute(sql`SELECT set_config('\"statement_timeout\"', '0', true)`);",
    "statement_timeout",
  ],
  [
    "schema qualified",
    "await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout', '0', true)`);",
    "statement_timeout",
  ],
  [
    "dynamic name",
    `await tx.execute(sql\`SELECT set_config(${settingExpression}, '0', true)\`);`,
    "dynamic set_config name",
  ],
  [
    "quoted dynamic name",
    `await tx.execute(sql\`SELECT set_config('${settingExpression}', '0', true)\`);`,
    "dynamic set_config name",
  ],
  [
    "dynamic SET name",
    `await tx.execute(sql\`SET LOCAL ${settingExpression} = 0\`);`,
    "dynamic timeout setting",
  ],
  [
    "unrelated shared query beside fake dedicated constructor",
    "const local = new SQL({ max: 1 }); await rootDb.execute(sql`SET statement_timeout = 0`);",
    "statement_timeout",
  ],
])("rejects %s", (_, body, expected) => {
  const source = `import { sql } from "drizzle-orm";\n${body}`;
  expect(names(source)).toContain(expected);
});

test("recognizes an imported SQL tag alias", () => {
  expect(
    names(
      "import { sql as fragment } from 'drizzle-orm'; fragment`SET SESSION statement_timeout TO DEFAULT`;",
    ),
  ).toEqual(["statement_timeout"]);
});

test("resolves local and imported setting names before allowing non-timeout settings", () => {
  const source = `
    import { sql } from "drizzle-orm";
    import { APP_SETTING, TIMEOUT_SETTING } from "@/api/db/setting-fixture";
    const local = "app.local";
    sql\`SELECT set_config(\${APP_SETTING}, 'x', true), set_config(\${local}, 'y', true)\`;
    sql\`SELECT set_config(\${TIMEOUT_SETTING}, '0', true)\`;
  `;
  const load = (file: string) =>
    file === "apps/api/src/db/setting-fixture.ts"
      ? 'export const APP_SETTING = "app.scope"; export const TIMEOUT_SETTING = "statement_timeout";'
      : undefined;
  expect(
    findApiTimeoutMutations(FILE, source, load).map(({ setting }) => setting),
  ).toEqual(["statement_timeout"]);
});

test("allows known non-timeout settings and read-only current_setting", () => {
  const source = `
    import { sql } from "drizzle-orm";
    const settings = { scope: "app.scope" } as const;
    sql\`SELECT set_config(\${settings.scope}, 'x', true)\`;
    sql\`SELECT current_setting('statement_timeout')\`;
  `;
  expect(names(source)).toEqual([]);
});

test("resolves setting constants re-exported by a barrel", () => {
  const source = `import { sql } from "drizzle-orm";
    import { APP_SETTING } from "@/api/db/schema";
    sql\`SELECT set_config(\${APP_SETTING}, 'x', true)\`;`;
  const files = new Map([
    ["apps/api/src/db/schema.ts", 'export * from "./schema/setting-fixture";'],
    [
      "apps/api/src/db/schema/setting-fixture.ts",
      'export const APP_SETTING = "app.scope";',
    ],
  ]);
  expect(
    findApiTimeoutMutations(FILE, source, (file) => files.get(file)),
  ).toEqual([]);
});

test("ignores non-SQL tagged templates and comments", () => {
  expect(
    names(
      "const html = (x: TemplateStringsArray) => x; html`SET statement_timeout = 0`; // SET statement_timeout = 0",
    ),
  ).toEqual([]);
});

test("only exempts explicit owners, online migration modules, tests, and scripts", () => {
  expect(isTimeoutMutationSource(FILE)).toBe(true);
  for (const file of [
    "apps/api/src/db/shared-pool-timeouts.ts",
    "apps/api/src/db/long-running-connection.ts",
    "apps/api/src/db/migration-runner.ts",
    "apps/api/src/db/online-migrations.ts",
    "apps/api/src/db/online-index-gate.ts",
    "apps/api/src/db/corpus-schema-lane.ts",
    "apps/api/src/db/corpus-projection-delete-receipt-repair.ts",
    "apps/api/src/db/corpus-projection-cleanup-stall-repair.ts",
    "apps/api/src/db/better-auth-oauth-resource-repair.ts",
    "apps/api/src/db/decision-date-ceiling-repair.ts",
    "apps/api/src/scripts/database-census.ts",
    "apps/api/src/handlers/example.test.ts",
  ]) {
    expect(isTimeoutMutationSource(file)).toBe(false);
    expect(findApiTimeoutMutations(file, "SET statement_timeout = 0")).toEqual(
      [],
    );
  }
  expect(
    isTimeoutMutationSource("apps/api/src/handlers/fake-migration.ts"),
  ).toBe(true);
  expect(isTimeoutMutationSource("apps/api/src/scripts/operator.ts")).toBe(
    true,
  );
});

test("dedicated owner may only mutate timeouts on its reserved connection", () => {
  const owner = "apps/api/src/db/long-running-connection.ts";
  const source = `
    import { SQL } from "bun";
    import { rootDb as shared } from "@/api/db/root";
    import { publicLawReadDb } from "@/api/lib/public-law-read-db";
    import { setSharedStatementTimeout as sharedBudget } from "@/api/db/shared-pool-timeouts";
    const local = new SQL({ max: 1 });
    await local.unsafe("SET LOCAL statement_timeout = '30s'");
    await shared.execute("SET statement_timeout = '0'");
    await sharedBudget(shared, 10_000);
    await import("./root");
    require("@/api/db/root");
  `;
  const findings = findApiTimeoutMutations(owner, source).map(
    ({ setting }) => setting,
  );
  expect(findings).toContain("shared-pool import @/api/db/root");
  expect(findings).toContain("shared-pool import @/api/lib/public-law-read-db");
  expect(findings).toContain(
    "shared-pool import @/api/db/shared-pool-timeouts",
  );
  expect(findings).toContain("shared-pool binding shared");
  expect(findings).toContain("shared-pool binding publicLawReadDb");
  expect(findings).toContain("shared-pool call sharedBudget");
  expect(findings).toContain("shared-pool import ./root");
  expect(
    findings.filter(
      (setting) => setting === "shared-pool import @/api/db/root",
    ),
  ).toHaveLength(2);
  expect(
    findApiTimeoutMutations(
      owner,
      'import { SQL } from "bun"; const client = new SQL({ max: 1 }); await client.unsafe("SET LOCAL statement_timeout = 30s");',
    ),
  ).toEqual([]);
});

test("dedicated owner rejects shared-setter calls through a namespace", () => {
  const findings = findApiTimeoutMutations(
    "apps/api/src/db/long-running-connection.ts",
    'import * as timeout from "@/api/db/shared-pool-timeouts"; await timeout.setSharedLockTimeout(tx, 1000); await timeout.setSharedFutureBudget(tx, 1000);',
  ).map(({ setting }) => setting);
  expect(findings).toContain("shared-pool call timeout.setSharedLockTimeout");
  expect(findings).toContain("shared-pool call timeout.setSharedFutureBudget");
});

test("dedicated owner fails closed on a dynamic import", () => {
  expect(
    findApiTimeoutMutations(
      "apps/api/src/db/long-running-connection.ts",
      "await import(moduleName);",
    ).map(({ setting }) => setting),
  ).toEqual(["dynamic import"]);
});

test("the full tree scan includes the dedicated owner", () => {
  const owner = "apps/api/src/db/long-running-connection.ts";
  const readPaths: string[] = [];
  const findings = checkApiTimeoutMutations({
    files: ["apps/api/src/handlers/example.test.ts", owner],
    read: (file) => {
      readPaths.push(file);
      return 'import { rootDb } from "@/api/db/root";';
    },
  });
  expect(readPaths).toEqual([owner]);
  expect(findings).toContainEqual({
    file: owner,
    line: 1,
    setting: "shared-pool import @/api/db/root",
  });
});
