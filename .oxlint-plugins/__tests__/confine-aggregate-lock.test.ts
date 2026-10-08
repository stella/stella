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
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/handlers/planted.ts",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule("confine-aggregate-lock", source, {
      cwd: "scratch",
      sourcePath: "apps/api/src/lib/db/aggregate-lock.ts",
    }),
  ).toEqual([]);
});
