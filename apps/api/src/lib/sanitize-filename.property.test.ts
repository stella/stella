import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { sanitizeFilename } from "@/api/lib/sanitize-filename";

// Mirror of the unsafe-character class the sanitizer strips. Independent of the
// implementation's regex so the assertion tests the contract, not the code.
const UNSAFE_CHAR = /["/\\<>\r\n\0|*?:]/u;

describe("sanitizeFilename (properties)", () => {
  test("output never contains an unsafe character", () => {
    assertProperty(
      "output never contains an unsafe character",
      fc.property(fc.string(), (name) => {
        expect(UNSAFE_CHAR.test(sanitizeFilename(name))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  test("output never contains a path-traversal sequence", () => {
    assertProperty(
      "output never contains a path-traversal sequence",
      fc.property(fc.string(), (name) => {
        expect(sanitizeFilename(name).includes("..")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  test("output has no leading or trailing dot", () => {
    assertProperty(
      "output has no leading or trailing dot",
      fc.property(fc.string(), (name) => {
        const out = sanitizeFilename(name);
        expect(out.startsWith(".")).toBe(false);
        expect(out.endsWith(".")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  test("output is always non-empty and at most 255 characters", () => {
    assertProperty(
      "output is always non-empty and at most 255 characters",
      fc.property(fc.string(), (name) => {
        const out = sanitizeFilename(name);
        expect(out.length).toBeGreaterThanOrEqual(1);
        expect(out.length).toBeLessThanOrEqual(255);
      }),
      { numRuns: 500 },
    );
  });

  test("sanitizing an already-sanitized name is a no-op (idempotent)", () => {
    assertProperty(
      "sanitizing an already-sanitized name is a no-op (idempotent)",
      fc.property(fc.string(), (name) => {
        const once = sanitizeFilename(name);
        expect(sanitizeFilename(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });
});
