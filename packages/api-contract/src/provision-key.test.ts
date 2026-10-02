import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { provisionKeyPartSchema } from "./provision-key";

const weightedText = fc
  .array(
    fc.oneof(
      {
        weight: 6,
        arbitrary: fc.constantFrom('"', "\\", ",", "]", "e\u0301", "r\u030c"),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom("a", "1", "_", "-", "🙂", "中", "é"),
      },
    ),
    { minLength: 1, maxLength: 40 },
  )
  .map((parts) => parts.join(""));

describe("provision identity text", () => {
  test("provision identity text normalizes delimiter-heavy Unicode to NFC", () => {
    assertProperty(
      "provision identity text normalizes delimiter-heavy Unicode to NFC",
      fc.property(weightedText, (raw) => {
        expect(v.parse(provisionKeyPartSchema, raw)).toBe(raw.normalize("NFC"));
      }),
    );
  });

  test("control characters and lone surrogates cannot enter provision identity", () => {
    assertProperty(
      "control characters and lone surrogates cannot enter provision identity",
      fc.property(
        fc.oneof(
          fc.integer({ min: 0, max: 31 }),
          fc.integer({ min: 127, max: 159 }),
          fc.integer({ min: 0xd8_00, max: 0xdf_ff }),
        ),
        weightedText,
        (code, text) => {
          expect(
            v.safeParse(
              provisionKeyPartSchema,
              `${text}${String.fromCodePoint(code)}`,
            ).success,
          ).toBe(false);
        },
      ),
    );
  });

  test.each(["", "\0", "\n", "\t", "\ud800", "\udfff", "\u202e", "\u200b"])(
    "rejects invalid identity text %j",
    (raw) => {
      expect(v.safeParse(provisionKeyPartSchema, raw).success).toBe(false);
    },
  );
});
