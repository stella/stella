import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { tPaginationLimit } from "@/api/lib/custom-schema";

describe("pagination limit schemas", () => {
  test("INVARIANT: public page sizes are positive integers", () => {
    const schema = tPaginationLimit(100);
    expect(Value.Check(schema, 1)).toBe(true);
    expect(Value.Check(schema, 10)).toBe(true);
    expect(Value.Check(schema, 100)).toBe(true);

    for (const invalid of [0, -1, 1.1, 1.5, 101, Number.NaN, Infinity]) {
      expect(Value.Check(schema, invalid), `accepted ${invalid}`).toBe(false);
    }
  });
});
