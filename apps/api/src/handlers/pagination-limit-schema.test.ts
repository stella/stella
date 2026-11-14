import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { paginationLimitSchema } from "@/api/lib/custom-schema";

describe("pagination limit schemas", () => {
  test("INVARIANT: public page sizes are positive integers", () => {
    const schema = paginationLimitSchema(100);
    expect(v.is(schema, 1)).toBe(true);
    expect(v.is(schema, 10)).toBe(true);
    expect(v.is(schema, 100)).toBe(true);

    for (const invalid of [0, -1, 1.1, 1.5, 101, Number.NaN, Infinity]) {
      expect(v.is(schema, invalid), `accepted ${invalid}`).toBe(false);
    }
  });
});
