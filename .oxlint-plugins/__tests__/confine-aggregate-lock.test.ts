import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

test("permits the pure invoice-lock owner and rejects its neighboring modules", async () => {
  const source =
    "export const snapshot = sql`SELECT id FROM invoices ORDER BY id FOR UPDATE`;";
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath:
        "apps/api/src/lib/db/aggregate-lock/invoice-transition-source.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/lib/db/aggregate-lock/neighbor.ts",
    }),
  ).toEqual([1]);
});

test("rejects the planted acquisition outside the aggregate owner", async () => {
  const source = readFileSync(
    new URL(
      "../__fixtures__/confine-aggregate-lock.fixture.ts",
      import.meta.url,
    ),
    "utf-8",
  ).replace(/^\/\/ oxlint-disable-next-line[^\n]*/gmu, "");
  expect(source).toContain('.for("update")');
  expect(source).toContain("pg_advisory_xact_lock_shared(");
  expect(source).toContain("pg_try_advisory_xact_lock_shared(");
  const lines = source.split("\n");
  const plantedLines = [
    '.for("update")',
    "pg_advisory_xact_lock_shared(",
    "pg_try_advisory_xact_lock_shared(",
  ].map(
    (marker) =>
      lines.findIndex(
        (line) => line.startsWith("tx.") && line.includes(marker),
      ) + 1,
  );
  expect(plantedLines.every((line) => line > 0)).toBe(true);
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/handlers/planted.ts",
    }),
  ).toEqual(plantedLines);
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/lib/db/aggregate-lock.ts",
    }),
  ).toEqual([]);
});

for (const primitive of [
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_xact_lock_shared",
]) {
  test(`confines ${primitive} in newly added production modules`, async () => {
    const source = `tx.execute("SELECT ${primitive}(1, 2)");`;
    expect(
      await lintSingleRule("confine-aggregate-lock", source, {
        cwd: "scratch",
        sourcePath: "packages/new/src/worker.ts",
      }),
    ).toEqual([1]);
  });
}
