import { describe, expect, test } from "bun:test";

import { slugify } from "./slug";

const ascii = {
  charset: "ascii",
  separator: "-",
  maxLength: 56,
  fallback: "item",
} as const;

describe("slugify", () => {
  test("lowercases and keeps the allowed characters", () => {
    expect(slugify("HelloWorld", ascii)).toBe("helloworld");
    expect(slugify("Skill123", ascii)).toBe("skill123");
  });

  test("collapses a run of rejected characters into one separator", () => {
    expect(slugify("a   b", ascii)).toBe("a-b");
    expect(slugify("foo___bar", ascii)).toBe("foo-bar");
    expect(slugify("a.b/c:d", ascii)).toBe("a-b-c-d");
  });

  test("trims leading and trailing separators", () => {
    expect(slugify("  hello  ", ascii)).toBe("hello");
    expect(slugify("---hello---", ascii)).toBe("hello");
  });

  test("does not transliterate under the ascii charset", () => {
    // Load-bearing: slugs are persisted, so folding "café" to "cafe" here
    // would start minting different keys for labels already in the database.
    expect(slugify("café", ascii)).toBe("caf");
    expect(slugify("Řeč", ascii)).toBe("e");
  });

  test("keeps letters and numbers of any script under the unicode charset", () => {
    expect(
      slugify("Jan Kowalski", {
        charset: "unicode",
        separator: "_",
        maxLength: 40,
        fallback: "field",
      }),
    ).toBe("jan_kowalski");
    expect(
      slugify("契約書", {
        charset: "unicode",
        separator: "_",
        maxLength: 40,
        fallback: "field",
      }),
    ).toBe("契約書");
  });

  test("clips to the budget without leaving a trailing separator", () => {
    const clipped = slugify("a ".repeat(200), { ...ascii, maxLength: 10 });
    expect(clipped.length).toBeLessThanOrEqual(10);
    expect(clipped.endsWith("-")).toBe(false);
  });

  test("terminates trimming a run of separators, for every separator", () => {
    // The trim loop shortens by one character per pass, which holds only
    // because a separator is one character; the union is what keeps it so.
    const separators = ["-", "_"] as const;
    for (const separator of separators) {
      expect(
        slugify("hello!!!!!!!!!!", {
          charset: "ascii",
          separator,
          maxLength: 6,
          fallback: "item",
        }),
      ).toBe("hello");
      expect(
        slugify("!!!!!!", {
          charset: "ascii",
          separator,
          maxLength: 6,
          fallback: "item",
        }),
      ).toBe("item");
    }
  });

  test("falls back when nothing survives", () => {
    expect(slugify("契約書", ascii)).toBe("item");
    expect(slugify("—", ascii)).toBe("item");
    expect(slugify("", ascii)).toBe("item");
  });
});
