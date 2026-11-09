import { expect, test } from "bun:test";
import * as v from "valibot";

import { uuidSchema } from "./uuid";

const uppercaseUuid = "550E8400-E29B-41D4-A716-446655440000";
const canonicalUuid = "550e8400-e29b-41d4-a716-446655440000";

test("UUID boundary accepts UUID casing and emits canonical lowercase", () => {
  expect(v.parse(uuidSchema, uppercaseUuid)).toBe(canonicalUuid);
  expect(v.parse(uuidSchema, canonicalUuid)).toBe(canonicalUuid);
  for (const invalid of ["malformed", uppercaseUuid.slice(1), "x".repeat(36)]) {
    expect(v.safeParse(uuidSchema, invalid).success).toBe(false);
  }
});
