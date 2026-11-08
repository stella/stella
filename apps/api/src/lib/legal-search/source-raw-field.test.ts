import { expect, test } from "bun:test";

import { readSourceRawField } from "./source-raw-field";

test("whole raw targets retain response text without decoding or normalisation", () => {
  for (const part of [
    "<record attr='1'>&amp;</record>",
    "<div>text</div>",
    ' { "id" : 1 }\n',
    "",
    "not JSON",
  ]) {
    expect(
      readSourceRawField(
        { detail: part },
        {
          type: "raw",
          part: "detail",
          path: [],
          reason: "The whole publisher response remains archived",
        },
      ),
    ).toBe(part);
  }
});

test("structured raw targets preserve array positions and expose missing fields", () => {
  const parts = {
    listing: JSON.stringify({ rows: [{ court: "A" }, {}, { court: null }] }),
  };
  expect(
    readSourceRawField(parts, {
      type: "raw",
      part: "listing",
      path: ["rows", "*", "court"],
      reason: "Each publisher row's original court",
    }),
  ).toEqual(["A", undefined, null]);
  expect(
    readSourceRawField(parts, {
      type: "raw",
      part: "missing",
      path: [],
      reason: "Missing response must remain visible",
    }),
  ).toBeUndefined();
});
