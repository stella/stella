import { expect, test } from "bun:test";

import { UPLOAD_DOCUMENT_MAX_BYTES } from "../../packages/api-contract/src/document-version-upload.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const MIB = 1024 * 1024;
const LIMIT_MIB = String(UPLOAD_DOCUMENT_MAX_BYTES / MIB);

test("rejects the document limit written out as products and literals", async () => {
  expect(
    await lintSingleRule(
      "no-literal-document-byte-limit",
      [
        `const MAX_REFERENCED_DOCX_BYTES = ${LIMIT_MIB} * 1024 * 1024;`,
        `const policy = { maxBytes: ${String(UPLOAD_DOCUMENT_MAX_BYTES)} };`,
        `const tooLarge = ${LIMIT_MIB} * 1024 * 1024 + 1;`,
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts other byte budgets and the imported constant", async () => {
  expect(
    await lintSingleRule(
      "no-literal-document-byte-limit",
      [
        "const previewMax = 25 * 1024 * 1024;",
        "const archiveMax = 256 * 1024 * 1024;",
        "const pageSize = 1024;",
        "const limit = UPLOAD_DOCUMENT_MAX_BYTES + 1;",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("exempts the owner, its generated CLI copy and the listed coincident budgets", async () => {
  const source = `export const LIMIT = ${LIMIT_MIB} * 1024 * 1024;`;
  const paths = [
    "packages/api-contract/src/document-version-upload.ts",
    "packages/cli/src/generated/document-version-upload-transport.ts",
    "packages/api-contract/src/skill-runner.ts",
    "packages/api-contract/src/other.ts",
  ];
  const reported = await Promise.all(
    paths.map(
      async (sourcePath) =>
        await lintSingleRule("no-literal-document-byte-limit", source, {
          sourcePath,
        }),
    ),
  );
  expect(reported).toEqual([[], [], [], [1]]);
});
