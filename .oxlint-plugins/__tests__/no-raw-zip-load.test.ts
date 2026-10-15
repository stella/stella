import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects default-import archive parsing through aliases", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import Archive from "jszip";\nArchive.loadAsync(bytes);',
      { sourcePath: "apps/api/src/handlers/files/read.ts" },
    ),
  ).toEqual([2]);
});

test("rejects instance and folder archive parsing", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nnew JSZip().loadAsync(bytes);\nconst archive = new JSZip();\narchive.folder("content").loadAsync(bytes);',
      { sourcePath: "apps/api/src/handlers/files/read.ts" },
    ),
  ).toEqual([2, 4]);
});

test("accepts the bounded archive reader and unrelated loaders", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      "loadDocxArchive(bytes);\nother.loadAsync(bytes);",
      { sourcePath: "apps/api/src/handlers/files/read.ts" },
    ),
  ).toEqual([]);
});

test("accepts the archive owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nJSZip.loadAsync(bytes);',
      { sourcePath: "apps/api/src/lib/docx-archive.ts" },
    ),
  ).toEqual([]);
});

test("keeps an owner basename elsewhere confined", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nJSZip.loadAsync(bytes);',
      { sourcePath: "apps/api/src/handlers/docx-archive.ts" },
    ),
  ).toEqual([2]);
});

test("accepts an operational script parsing an archive", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nJSZip.loadAsync(bytes);',
      { sourcePath: "apps/api/src/scripts/archive-audit.ts" },
    ),
  ).toEqual([]);
});

test("accepts archive parsing inside the file scan owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nJSZip.loadAsync(bytes);',
      { sourcePath: "apps/api/src/lib/file-scan/zip.ts" },
    ),
  ).toEqual([]);
});

test("accepts archive parsing in test fixtures", async () => {
  expect(
    await lintSingleRule(
      "no-raw-zip-load",
      'import JSZip from "jszip";\nJSZip.loadAsync(bytes);',
      { sourcePath: "apps/api/src/handlers/files/read.test.ts" },
    ),
  ).toEqual([]);
});
