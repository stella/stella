import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects direct imported namespace and forward type alias casts", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import type { ScannedFile as Checked } from "@/api/lib/file-scan/scanned-file";\nimport type * as keys from "@/api/lib/file-key";\nconst a = value as Checked;\nconst b = value as keys.FileKey;\nconst c = value as Later;\ntype Later = ScannedFile;',
      { sourcePath: "apps/api/src/handlers/example.ts", cwd: "scratch" },
    ),
  ).toEqual([3, 4, 5]);
});

test("rejects raw minting and key schema imports outside owners", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";\nimport { fileKeySchema } from "@/api/lib/file-key";',
      { sourcePath: "apps/api/src/handlers/example.ts", cwd: "scratch" },
    ),
  ).toEqual([1, 2]);
});

test("confines raw Folio parsers and buffer review", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { parseDocx, FolioDocxReviewer as Reviewer } from "@stll/folio-core";\nimport * as folio from "@stll/folio-core/server";\nfolio.docxToMarkdown(bytes);\nReviewer.fromBuffer(bytes);',
      { sourcePath: "apps/api/src/handlers/example.ts", cwd: "scratch" },
    ),
  ).toEqual([1, 3, 4]);
});

test("allows minting at the scan owner", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";',
      {
        sourcePath: "apps/api/src/lib/file-scan/scan-upload.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("does not exempt a same basename in a different directory", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";',
      { sourcePath: "apps/api/src/other/scan-upload.ts", cwd: "scratch" },
    ),
  ).toEqual([1]);
});

test("exempts test parsers but still rejects branded casts", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { parseDocx } from "@stll/folio-core";\nconst file = value as ScannedFile;',
      { sourcePath: "apps/api/src/tests/example.test.ts", cwd: "scratch" },
    ),
  ).toEqual([2]);
});

test("allows parser wrappers and unrelated type assertions", async () => {
  expect(
    await lintSingleRule(
      "scanned-file-boundary",
      'import { parseDocx } from "@stll/folio-core";\nconst file = value as DBFileKey;',
      {
        sourcePath: "apps/api/src/lib/file-scan/document-parsers.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});
