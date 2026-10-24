import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { decodeCaseFileCursor } from "@/api/handlers/case-law/decisions/case-file";
import { encodePaginationCursor } from "@/api/lib/pagination";

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
