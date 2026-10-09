import { expect, test } from "bun:test";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

const SOURCE_ROOT = import.meta.dirname;
const DIRECT_GLOB = ["new Bun.", "Glob"].join("");
const DIRECT_DIRECTORY_WALK = ["readdir", "Sync("].join("");

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
