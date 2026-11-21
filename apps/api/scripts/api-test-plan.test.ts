import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listApiTestPaths,
  planApiTestBatches,
  readApiTestSourceIndex,
} from "./api-test-plan";
import { TEST_BATCH_KIND } from "./test-batch-plan";

test("selected plans do not read unrelated discovered tests", async () => {
  const apiRoot = mkdtempSync(path.join(tmpdir(), "api-test-plan-"));
  const selectedPath = "src/selected.test.ts";
  const unrelatedPath = "src/unrelated.test.ts";
  try {
    mkdirSync(path.join(apiRoot, "src"));
    await Bun.write(
      path.join(apiRoot, selectedPath),
      'test("selected", () => {});',
    );
    await Bun.write(
      path.join(apiRoot, unrelatedPath),
      'test("unrelated", () => {});',
    );
    expect(listApiTestPaths(apiRoot)).toContain(unrelatedPath);

    const sourceIndex = await readApiTestSourceIndex(apiRoot, [selectedPath], {
      discovery: "additional-only",
    });
    expect(sourceIndex.testPaths).toEqual([selectedPath]);

    const groups = await planApiTestBatches({
      apiRoot,
      propertyOnly: false,
      testPaths: [selectedPath],
    });

    expect(
      groups.find(({ kind }) => kind === TEST_BATCH_KIND.regular)?.testBatches,
    ).toEqual([[selectedPath]]);
  } finally {
    rmSync(apiRoot, { force: true, recursive: true });
  }
});
