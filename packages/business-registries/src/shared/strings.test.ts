import { describe, expect, test } from "bun:test";

import { trimToNull } from "./strings.js";

describe("trimToNull", () => {
  test("trims surrounding whitespace", () => {
    expect(trimToNull("  hello  ")).toBe("hello");
  });

  test("collapses empty and whitespace-only strings to null", () => {
    expect(trimToNull("")).toBeNull();
    expect(trimToNull("   ")).toBeNull();
  });

  test("maps null and undefined to null", () => {
    expect(trimToNull(null)).toBeNull();
    expect(trimToNull(undefined)).toBeNull();
  });

  test("preserves a literal '0' (real address atom / sentinel handled per field)", () => {
    expect(trimToNull("0")).toBe("0");
  });

  // Class guard: several adapters (recherche-entreprises in particular)
  // only shape-check a couple of fields, so an optional field the upstream
  // declared as a string can arrive as a number/boolean/object at runtime.
  // The consolidated helper must treat any non-string as absent rather than
  // throwing a raw TypeError from `.trim()`, matching the per-adapter
  // helpers it replaced. If a future change re-narrows this to reject
  // non-strings, this test fails.
  test("treats a non-string value as absent instead of throwing", () => {
    expect(trimToNull(42)).toBeNull();
    expect(trimToNull(true)).toBeNull();
    expect(trimToNull({ a: 1 })).toBeNull();
    expect(trimToNull([1, 2, 3])).toBeNull();
  });
});
