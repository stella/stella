import { expect, test } from "bun:test";

import {
  containsJsxTag,
  sourceFileIndex,
} from "@stll/scripts/src/source-file-index";

const SOURCE_ROOT = import.meta.dirname;
const DIRECT_GLOB = ["new Bun.", "Glob"].join("");
const DIRECT_DIRECTORY_WALK = ["readdir", "Sync("].join("");
const IDENTIFIER_START_FIXTURE =
  "__fixtures__/inventory-prefilter/identifier-starts.tsx";

test("repository inventory tests use the shared source file index", () => {
  const directScanners = sourceFileIndex(SOURCE_ROOT)
    .filter(({ relativePath }) =>
      /(?:inventory|census)\.test\.tsx?$/u.test(relativePath),
    )
    .filter(
      ({ sourceText }) =>
        sourceText.includes(DIRECT_GLOB) ||
        sourceText.includes(DIRECT_DIRECTORY_WALK),
    )
    .map(({ relativePath }) => relativePath);

  expect(directScanners).toEqual([]);
});

test("repository inventory JSX prefilters accept every identifier start", () => {
  const fixture = sourceFileIndex(SOURCE_ROOT).find(
    ({ relativePath }) => relativePath === IDENTIFIER_START_FIXTURE,
  );

  expect(fixture).toBeDefined();
  if (fixture === undefined) {
    return;
  }
  expect(fixture.sourceText).not.toMatch(/<[A-Za-z]/u);
  expect(containsJsxTag(fixture.sourceText)).toBe(true);
});
