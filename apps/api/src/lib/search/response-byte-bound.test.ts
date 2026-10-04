import { expect, test } from "bun:test";
import { t } from "elysia";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { responseByteBound } from "./response-byte-bound";
import { boundedString, truncateTextBytes } from "./response-text-bounds";

test("finite schema bounds cover JSON escaping, nullable values, arrays and records", () => {
  const textSchema = boundedString(128);
  const schema = t.Object({
    label: textSchema,
    items: t.Array(t.Union([textSchema, t.Null(), t.Number(), t.Boolean()]), {
      maxItems: 4,
    }),
    metadata: t.Record(textSchema, textSchema, {
      maxProperties: 1,
      propertyNames: textSchema,
    }),
    kind: t.UnionEnum(["first", "second"]),
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
  expect(() => responseByteBound(t.String())).toThrow(
    "Public response schema has no finite bound",
  );
  expect(() => responseByteBound(t.Array(boundedString(16)))).toThrow(
    "Public response schema has no finite bound",
  );
  expect(() =>
    responseByteBound(
      t.Object({ label: boundedString(16) }, { additionalProperties: true }),
    ),
  ).toThrow("Public response object allows undeclared properties");
});
