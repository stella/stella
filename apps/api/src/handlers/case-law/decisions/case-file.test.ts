import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  decodeCaseFileCursor,
  isCaseFileCursor,
} from "@/api/handlers/case-law/decisions/case-file";
import { encodePaginationCursor } from "@/api/lib/pagination";

test("only a file key and a document key make a case file cursor", () => {
  expect(isCaseFileCursor(encodePaginationCursor(["file", "document"]))).toBe(
    true,
  );
  for (const cursor of [
    "not-a-cursor",
    encodePaginationCursor(["file"]),
    encodePaginationCursor(["file", "document", "extra"]),
    encodePaginationCursor(["file", 1]),
    encodePaginationCursor([null, "document"]),
  ]) {
    expect({ cursor, valid: isCaseFileCursor(cursor) }).toEqual({
      cursor,
      valid: false,
    });
  }
});

test("case file cursors round-trip only within their file", () => {
  assertProperty(
    "case file cursors round-trip only within their file",
    fc.property(fc.string(), fc.string(), (fileKey, documentKey) => {
      const cursor = encodePaginationCursor([fileKey, documentKey]);
      expect(decodeCaseFileCursor(cursor, fileKey)).toBe(documentKey);
      expect(decodeCaseFileCursor(cursor, `${fileKey}x`)).toBe(false);
    }),
  );
});
