import { expect, test } from "bun:test";
import * as v from "valibot";

import { projectResponseText } from "./project-response-text";
import { responseByteBound } from "./response-byte-bound";
import { boundedString, truncateTextBytes } from "./response-text-bounds";

test("response text projection preserves and bounds every union branch", () => {
  const short = { type: "short", maxBytes: 8 } as const;
  const long = { type: "long", maxBytes: 16 } as const;
  const shortSchema = v.object({
    type: v.literal(short.type),
    text: boundedString(short.maxBytes),
  });
  const longSchema = v.object({
    type: v.literal(long.type),
    text: boundedString(long.maxBytes),
  });
  const schemas = [
    v.union([shortSchema, longSchema]),
    v.variant("type", [shortSchema, longSchema]),
  ];

  for (const schema of schemas) {
    for (const branch of [short, long]) {
      for (const text of ["😀ř", "e\u0301", '\u0000"\\', "\ud800"]) {
        const input = { type: branch.type, text: text.repeat(100) };
        const projected = projectResponseText(input, schema);
        expect(projected).toEqual({
          type: branch.type,
          text: truncateTextBytes(input.text, branch.maxBytes),
        });
        expect(v.is(schema, projected)).toBe(true);
        expect(
          Buffer.byteLength(JSON.stringify(projected)),
        ).toBeLessThanOrEqual(responseByteBound(schema));
        expect(input.text).toBe(text.repeat(100));
      }
    }
  }
});
