import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  FILE_PART_KINDS,
  FILE_PART_MAX_DEPTH,
  FILE_PART_MAX_INDEX,
  FILE_PART_TEXT_PREVIEW_MAX_BYTES,
  type FilePart,
  filePartDepth,
  filePartId,
  filePartIdSchema,
  filePartInlineBytes,
  filePartWithin,
  isFilePartTextMediaType,
  parseFilePartId,
  splitOutermostFilePart,
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

describe("a part of a part", () => {
  test("every path up to the deepest a part may sit round-trips through its address", () => {
    const kinds = Object.values(FILE_PART_KINDS);
    for (let depth = 1; depth <= FILE_PART_MAX_DEPTH; depth += 1) {
      let part: FilePart | undefined;
      for (let level = 0; level < depth; level += 1) {
        const segment = {
          kind: kinds[level % kinds.length] ?? FILE_PART_KINDS.member,
          index: level === 0 ? FILE_PART_MAX_INDEX : level,
        };
        part = part === undefined ? segment : { ...segment, within: part };
      }
      if (part === undefined) {
        throw new Error("No part built");
      }
      const id = filePartId(part);
      expect(id.split("/")).toHaveLength(depth);
      expect(filePartDepth(part)).toBe(depth);
      expect(parseFilePartId(id)).toEqual(part);
      expect(v.is(filePartIdSchema, id)).toBe(true);
    }
  });

  test.each([
    "member:0/member:1/member:2/member:3/member:4",
    "member:0/",
    "/member:0",
    "member:0//member:1",
    "member:0/signature:1",
    "member:0\\attachment:1",
  ])("%s addresses nothing", (value) => {
    expect(parseFilePartId(value)).toBeNull();
    expect(v.is(filePartIdSchema, value)).toBe(false);
  });
});

describe("a part addressed through its container", () => {
  test.each([
    "message:3",
    "message:3/attachment:0",
    "member:2/message:9999/attachment:1",
    "attachment:0/member:1/message:2/attachment:3",
  ])(
    "%s splits into its outermost part and the path within it, and nests back",
    (id) => {
      const part = parseFilePartId(id);
      if (part === null) {
        throw new Error(`${id} must parse`);
      }
      const { outermost, inner } = splitOutermostFilePart(part);
      expect(outermost.within).toBeUndefined();
      if (inner === null) {
        expect(filePartId(outermost)).toBe(id);
        return;
      }
      expect(`${filePartId(outermost)}/${filePartId(inner)}`).toBe(id);
      expect(filePartId(filePartWithin(inner, outermost))).toBe(id);
    },
  );

  test("a part of a message is addressed under the message", () => {
    expect(
      filePartId(
        filePartWithin(
          { kind: FILE_PART_KINDS.attachment, index: 0 },
          { kind: FILE_PART_KINDS.message, index: 3 },
        ),
      ),
    ).toBe("message:3/attachment:0");
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
