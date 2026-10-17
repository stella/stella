import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { planApiTestBatches } from "./api-test-plan";
import { TEST_BATCH_KIND } from "./test-batch-plan";

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
  tempRoots = [];
});

test("source substring markers classify helper and heavy-logic tests", async () => {
  const apiRoot = mkdtempSync(path.join(tmpdir(), "stella-api-test-plan-"));
  tempRoots.push(apiRoot);
  mkdirSync(path.join(apiRoot, "src/tests/helpers"), { recursive: true });
  mkdirSync(path.join(apiRoot, "scripts"), { recursive: true });
  writeFileSync(
    path.join(apiRoot, "src/tests/helpers/mock-context.ts"),
    'mock.module("@/api/db/root", () => ({}));',
  );
  const sources = {
    "scripts/helper.test.ts":
      'const helperPath = "prefix tests/helpers/mock-context suffix";',
    "scripts/heavy.test.ts":
      'const clientMarker = "@modelcontextprotocol/client-extra";',
    "scripts/case.test.ts":
      'const clientMarker = "@MODELCONTEXTPROTOCOL/client";',
  };
  for (const [testPath, source] of Object.entries(sources)) {
    writeFileSync(path.join(apiRoot, testPath), source);
  }

  const groups = await planApiTestBatches({
    apiRoot,
    executionMode: "measure-rss",
    propertyOnly: false,
    testPaths: Object.keys(sources),
  });
  const kindFor = (testPath: string) =>
    groups.find(({ testBatches }) =>
      testBatches.some((batch) => batch.includes(testPath)),
    )?.kind;

  expect(kindFor("scripts/helper.test.ts")).toBe(TEST_BATCH_KIND.moduleMock);
  expect(kindFor("scripts/heavy.test.ts")).toBe(TEST_BATCH_KIND.heavyLogic);
  expect(kindFor("scripts/case.test.ts")).toBe(TEST_BATCH_KIND.regular);
});
