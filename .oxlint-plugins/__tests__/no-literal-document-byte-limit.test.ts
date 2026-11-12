import { expect, test } from "bun:test";

import {
  MULTIPART_DOCUMENT_MAX_BYTES,
  UPLOAD_DOCUMENT_MAX_BYTES,
} from "../../packages/api-contract/src/limits.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const MIB = 1024 * 1024;

test("rejects the document limits written out as products and literals", async () => {
  expect(
    await lintSingleRule(
      "no-literal-document-byte-limit",
      [
        `const MAX_REFERENCED_DOCX_BYTES = ${String(UPLOAD_DOCUMENT_MAX_BYTES / MIB)} * 1024 * 1024;`,
        `const policy = { maxBytes: ${String(UPLOAD_DOCUMENT_MAX_BYTES)} };`,
        `const tooLarge = ${String(UPLOAD_DOCUMENT_MAX_BYTES / MIB)} * 1024 * 1024 + 1;`,
        `const formMax = ${String(MULTIPART_DOCUMENT_MAX_BYTES / MIB)} * 1024 * 1024;`,
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
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

test("exempts the owner module and the CLI copy generated from it", async () => {
  const source = `export const UPLOAD_DOCUMENT_MAX_BYTES = ${String(UPLOAD_DOCUMENT_MAX_BYTES / MIB)} * 1024 * 1024;`;
  expect(
    await lintSingleRule("no-literal-document-byte-limit", source, {
      sourcePath: "packages/api-contract/src/document-version-upload.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("no-literal-document-byte-limit", source, {
      sourcePath:
        "packages/cli/src/generated/document-version-upload-transport.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("no-literal-document-byte-limit", source, {
      sourcePath: "packages/api-contract/src/other.ts",
    }),
  ).toEqual([1]);
});
