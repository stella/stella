import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { responseByteBound } from "./response-byte-bound";
import { boundedString, truncateTextBytes } from "./response-text-bounds";

test("finite schema bounds cover JSON escaping, nullable values, arrays and records", () => {
  const textSchema = boundedString(128);
  const schema = v.object({
    label: textSchema,
    items: v.pipe(
      v.array(v.union([textSchema, v.null(), v.number(), v.boolean()])),
      v.maxLength(4),
    ),
    metadata: v.pipe(v.record(textSchema, textSchema), v.maxEntries(1)),
    kind: v.picklist(["first", "second"]),
  });
  assertProperty(
    "finite schema bounds cover JSON escaping, nullable values, arrays and records",
    fc.property(
      fc.array(fc.constantFrom("😀", "ř", "\u0000", "\\", '"', "\ud800"), {
        minLength: 1,
        maxLength: 20,
      }),
      (characters) => {
        const text = truncateTextBytes(characters.join("").repeat(100), 128);
        const response = {
          label: text,
          items: [text, null, -Number.MAX_VALUE, false],
          metadata: { [text]: text },
          kind: "second",
        };
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
          responseByteBound(schema),
        );
      },
    ),
    { numRuns: 12 },
  );
});

test("an unbounded schema cannot produce a finite envelope claim", () => {
  expect(() => responseByteBound(v.string())).toThrow(
    "Public response schema has no finite maxLength at $",
  );
  expect(() => responseByteBound(v.array(boundedString(16)))).toThrow(
    "Public response schema has no finite maxItems at $",
  );
  expect(() =>
    responseByteBound(v.record(boundedString(16), boundedString(16))),
  ).toThrow("Public response schema has no finite maxProperties at $");
  expect(() =>
    responseByteBound(v.looseObject({ label: boundedString(16) })),
  ).toThrow("Public response object allows undeclared properties");
  expect(() =>
    responseByteBound(
      v.objectWithRest({ label: boundedString(16) }, boundedString(16)),
    ),
  ).toThrow("Public response object allows undeclared properties");
});
