import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { updateVariantBodySchema } from "./variants";

const expectedUpdatedAt = "2026-10-11T10:00:00.000Z";
const body = [{ text: "The Tenant shall indemnify the Landlord." }];

describe("updateVariantBodySchema — sortOrder", () => {
  test("accepts a sortOrder-only update (reorder)", () => {
    expect(
      Value.Check(updateVariantBodySchema, { sortOrder: 2, expectedUpdatedAt }),
    ).toBe(true);
  });

  test("accepts a label + body update (edit) without sortOrder", () => {
    expect(
      Value.Check(updateVariantBodySchema, {
        label: "Short form",
        body,
        expectedUpdatedAt,
      }),
    ).toBe(true);
  });

  test("rejects edits without the read version", () => {
    expect(
      Value.Check(updateVariantBodySchema, { label: "Short form", body }),
    ).toBe(false);
  });

  test("rejects a negative sortOrder", () => {
    expect(
      Value.Check(updateVariantBodySchema, {
        sortOrder: -1,
        expectedUpdatedAt,
      }),
    ).toBe(false);
  });

  test("rejects a non-integer sortOrder", () => {
    expect(
      Value.Check(updateVariantBodySchema, {
        sortOrder: 1.5,
        expectedUpdatedAt,
      }),
    ).toBe(false);
  });
});
