import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { updateVariantBodySchema } from "./variants";

const body = [{ text: "The Tenant shall indemnify the Landlord." }];

describe("updateVariantBodySchema — sortOrder", () => {
  test("accepts a sortOrder-only update (reorder)", () => {
    expect(Value.Check(updateVariantBodySchema, { sortOrder: 2 })).toBe(true);
  });

  test("accepts a label + body update (edit) without sortOrder", () => {
    expect(
      Value.Check(updateVariantBodySchema, { label: "Short form", body }),
    ).toBe(true);
  });

  test("rejects a negative sortOrder", () => {
    expect(Value.Check(updateVariantBodySchema, { sortOrder: -1 })).toBe(false);
  });

  test("rejects a non-integer sortOrder", () => {
    expect(Value.Check(updateVariantBodySchema, { sortOrder: 1.5 })).toBe(
      false,
    );
  });
});
