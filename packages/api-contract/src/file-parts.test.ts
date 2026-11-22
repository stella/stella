import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  FILE_PART_KINDS,
  FILE_PART_MAX_INDEX,
  FILE_PART_TEXT_PREVIEW_MAX_BYTES,
  filePartId,
  filePartIdSchema,
  filePartInlineBytes,
  isFilePartTextMediaType,
  parseFilePartId,
} from "./file-parts";

describe("file part addresses", () => {
  test("every kind and position round-trips through its address", () => {
    for (const kind of Object.values(FILE_PART_KINDS)) {
      for (const index of [0, 1, 42, FILE_PART_MAX_INDEX]) {
        const id = filePartId({ kind, index });
        expect(parseFilePartId(id)).toEqual({ kind, index });
        expect(v.is(filePartIdSchema, id)).toBe(true);
      }
    }
  });

  test.each([
    "attachment",
    "attachment:",
    "attachment:-1",
    "attachment:01",
    "attachment:10000",
    "attachment:1.5",
    "Attachment:1",
    "member:1 ",
    "signature:0",
    "constructor:0",
  ])("%s addresses nothing", (value) => {
    expect(parseFilePartId(value)).toBeNull();
    expect(v.is(filePartIdSchema, value)).toBe(false);
  });
});

describe("a part delivered inline", () => {
  const long = new Uint8Array(FILE_PART_TEXT_PREVIEW_MAX_BYTES * 3).fill(0x61);

  test.each(["text/plain", "TEXT/CSV; charset=utf-8", "application/xml"])(
    "a long %s part carries one byte past its preview",
    (mediaType) => {
      expect(isFilePartTextMediaType(mediaType)).toBe(true);
      expect(filePartInlineBytes(long, mediaType).byteLength).toBe(
        FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1,
      );
    },
  );

  test.each([
    FILE_PART_TEXT_PREVIEW_MAX_BYTES,
    FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1,
  ])("a text part of %d bytes is whole", (size) => {
    const bytes = long.subarray(0, size);
    expect(filePartInlineBytes(bytes, "text/plain")).toBe(bytes);
  });

  test.each(["application/pdf", "image/png", "text/html"])(
    "a %s part is whole, however long",
    (mediaType) => {
      expect(isFilePartTextMediaType(mediaType)).toBe(false);
      expect(filePartInlineBytes(long, mediaType)).toBe(long);
    },
  );
});
