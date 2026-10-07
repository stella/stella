import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects unguarded update and delete table aliases", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries as guard } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n await tx.update(entries);\n await tx.delete(entries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([4, 5]);
});

test("accepts an awaited same transaction guard and immediate refusal", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries as guard } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n const refused = await guard({ tx });\n if (refused) { return refused; }\n await tx.update(entries);\n await tx.delete(entries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("rejects guards on a different transaction", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries as guard } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx, other) {\n const refused = await guard({ tx: other });\n if (refused) return refused;\n await tx.update(entries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});

test("rejects a guard result that does not return on refusal", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries as guard } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n const refused = await guard({ tx });\n if (refused) record(refused);\n await tx.delete(entries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});

test("rejects a same named guard from another module", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "./guard";\nasync function mutate(tx) {\n const refused = await guardRunningTimeEntries({ tx });\n if (refused) return refused;\n await tx.update(timeEntries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});

test("rejects raw SQL mutations but accepts ordinary tables", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      `import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries as guard } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n await tx.execute(sql\`UPDATE time_entries SET value = 1\`);\n await tx.execute(sql\`DELETE FROM \${entries} WHERE id = \${id}\`);\n await tx.update(otherTable);\n}`,
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([4, 5]);
});

test("rejects a guard awaited after the mutation", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n await tx.update(timeEntries);\n const refused = await guardRunningTimeEntries({ tx });\n if (refused) return refused;\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([4]);
});

test("rejects a guard called without awaiting the refusal", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n const refused = guardRunningTimeEntries({ tx });\n if (refused) return refused;\n await tx.update(timeEntries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});

test("does not count a guard inside a nested callback", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n const check = async () => { const refused = await guardRunningTimeEntries({ tx }); if (refused) return refused; };\n await tx.update(timeEntries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([5]);
});

test("does not trust a shadowed local guard helper", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx, guardRunningTimeEntries) {\n const refused = await guardRunningTimeEntries({ tx });\n if (refused) return refused;\n await tx.update(timeEntries);\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});

test("does not confuse a same named inner transaction with the guarded one", async () => {
  expect(
    await lintSingleRule(
      "require-running-entry-guard",
      'import { timeEntries } from "@/api/db/schema/billing";\nimport { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";\nasync function mutate(tx) {\n const refused = await guardRunningTimeEntries({ tx });\n if (refused) return refused;\n { const tx = other; await tx.update(timeEntries); }\n}',
      { sourcePath: "apps/api/src/handlers/time/write.ts", cwd: "scratch" },
    ),
  ).toEqual([6]);
});
