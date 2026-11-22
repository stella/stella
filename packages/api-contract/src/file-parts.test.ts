import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  FILE_PART_KINDS,
  FILE_PART_MAX_INDEX,
  filePartId,
  filePartIdSchema,
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
