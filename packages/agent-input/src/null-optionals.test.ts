import { describe, expect, test } from "bun:test";

import { withNullOptionalsOmitted } from "./null-optionals";

describe("browser-safe optional JSON values", () => {
  test("object enum and const branch matching compares nested JSON values independently of key order", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            choice: { const: { fields: ["a", { n: 1 }], flag: true } },
            note: { type: "null" },
          },
          required: ["choice"],
        },
        {
          type: "object",
          properties: {
            choice: { enum: [{ fields: ["b", { n: 2 }], flag: false }] },
            note: { type: "string" },
          },
          required: ["choice"],
        },
      ],
    };
    const kept = {
      choice: { flag: true, fields: ["a", { n: 1 }] },
      note: null,
    };
    const omitted = {
      choice: { flag: false, fields: ["b", { n: 2 }] },
      note: null,
    };
    expect(withNullOptionalsOmitted(schema, kept)).toEqual(kept);
    expect(withNullOptionalsOmitted(schema, omitted)).toEqual({
      choice: omitted.choice,
    });
  });
});
