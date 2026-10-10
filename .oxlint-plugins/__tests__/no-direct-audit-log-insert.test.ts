import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const sources = [
  "await tx.insert(auditLogs).values(rows);",
  'import { auditLogs as table } from "@/api/db/schema";\nawait tx.insert(table).values(rows);',
  "function write(tx) { return tx.insert ( auditLogs ); }",
];

test.each(sources)("rejects direct audit writes: %s", async (source) => {
  expect(
    await lintSingleRule("no-direct-audit-log-insert", source, {
      sourcePath: "apps/api/src/handlers/example.ts",
    }),
  ).toEqual([source.split("\n").length]);
});

test("allows the audit owner and unrelated inserts", async () => {
  expect(
    await lintSingleRule(
      "no-direct-audit-log-insert",
      "tx.insert(auditLogs);",
      { sourcePath: "apps/api/src/lib/audit-log.ts" },
    ),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      "no-direct-audit-log-insert",
      "tx.insert(otherLogs);",
      { sourcePath: "apps/api/src/handlers/example.ts" },
    ),
  ).toEqual([]);
});
