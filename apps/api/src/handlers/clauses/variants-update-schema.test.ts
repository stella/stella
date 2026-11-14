import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { updateVariantBodySchema } from "./variants";

const body = [{ text: "The Tenant shall indemnify the Landlord." }];

describe("updateVariantBodySchema — sortOrder", () => {
  test("accepts a sortOrder-only update (reorder)", () => {
    expect(v.is(updateVariantBodySchema, { sortOrder: 2 })).toBe(true);
  });

  test("accepts a label + body update (edit) without sortOrder", () => {
    expect(v.is(updateVariantBodySchema, { label: "Short form", body })).toBe(
      true,
    );
  });

  test("rejects a negative sortOrder", () => {
    expect(v.is(updateVariantBodySchema, { sortOrder: -1 })).toBe(false);
  });

  test("rejects a non-integer sortOrder", () => {
    expect(v.is(updateVariantBodySchema, { sortOrder: 1.5 })).toBe(false);
  });
});
