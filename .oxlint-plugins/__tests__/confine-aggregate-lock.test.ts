import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

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
  const plantedLine =
    source
      .split("\n")
      .findIndex(
        (line) => line.startsWith("tx.") && line.includes('.for("update")'),
      ) + 1;
  expect(plantedLine).toBeGreaterThan(0);
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/handlers/planted.ts",
    }),
  ).toEqual([plantedLine, plantedLine, plantedLine]);
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
