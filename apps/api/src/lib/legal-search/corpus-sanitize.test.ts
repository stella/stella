import { describe, expect, test } from "bun:test";

import { sanitizeMetadata } from "@/api/lib/legal-search/corpus-sanitize";

describe("sanitizeMetadata", () => {
  test("sanitizes nested strings and arrays recursively", () => {
    expect(
      sanitizeMetadata({
        title: "A\u0000B",
        nested: {
          label: "C\u200BD",
          items: ["E\u00A0F", { note: "G\u0000H" }],
        },
      }),
    ).toEqual({
      title: "AB",
      nested: {
        label: "CD",
        items: ["E F", { note: "GH" }],
      },
    });
  });

  test("preserves external keys without changing the result prototype", () => {
    const metadata: Record<string, unknown> = { ordinary: "value" };
    Object.defineProperty(metadata, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { label: "A\u0000B", polluted: true },
      writable: true,
    });

    const sanitized = sanitizeMetadata(metadata);

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(true);
    expect(Reflect.get(sanitized, "__proto__")).toEqual({
      label: "AB",
      polluted: true,
    });
    expect(Reflect.get(sanitized, "polluted")).toBeUndefined();
  });
});
