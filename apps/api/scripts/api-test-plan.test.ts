import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hasPropertyTest, listApiTestPaths } from "./api-test-plan";

test("lists test files under the runner roots only", async () => {
  const apiRoot = mkdtempSync(path.join(tmpdir(), "api-test-plan-"));
  try {
    mkdirSync(path.join(apiRoot, "src"));
    mkdirSync(path.join(apiRoot, "fixtures"));
    await Bun.write(path.join(apiRoot, "src/b.test.ts"), "");
    await Bun.write(path.join(apiRoot, "src/a.test.tsx"), "");
    await Bun.write(path.join(apiRoot, "src/helper.ts"), "");
    await Bun.write(path.join(apiRoot, "fixtures/outside.test.ts"), "");

    expect(listApiTestPaths(apiRoot)).toEqual([
      "src/a.test.tsx",
      "src/b.test.ts",
    ]);
  } finally {
    rmSync(apiRoot, { force: true, recursive: true });
  }
});

test("recognizes property tests by their assertion call", () => {
  expect(hasPropertyTest("fc.assert(fc.property(fc.nat(), () => true));")).toBe(
    true,
  );
  expect(hasPropertyTest("await assertProperty(arbitrary, check);")).toBe(true);
  expect(hasPropertyTest('test("plain", () => {});')).toBe(false);
});
