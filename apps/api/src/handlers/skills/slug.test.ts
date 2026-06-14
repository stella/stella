import { describe, expect, test } from "bun:test";

import { collisionSuffix, slugify, uniqueSlug } from "./slug";

const SLUG_MAX = 56;
const UNIQUE_MAX = 64;

describe("slugify", () => {
  test("lowercases and keeps alphanumerics", () => {
    expect(slugify("HelloWorld")).toBe("helloworld");
    expect(slugify("Skill123")).toBe("skill123");
  });

  test("collapses runs of non-slug chars into a single hyphen", () => {
    expect(slugify("hello world")).toBe("hello-world");
    expect(slugify("a   b")).toBe("a-b");
    expect(slugify("foo___bar")).toBe("foo-bar");
    expect(slugify("foo - bar")).toBe("foo-bar");
    expect(slugify("a.b/c:d")).toBe("a-b-c-d");
  });

  test("trims leading and trailing separators", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("---hello---")).toBe("hello");
    expect(slugify("!!!skill!!!")).toBe("skill");
  });

  test("drops non-ASCII characters (no transliteration)", () => {
    // Unicode letters are not in a-z0-9, so they are treated as separators.
    expect(slugify("café")).toBe("caf");
    expect(slugify("naïve résumé")).toBe("na-ve-r-sum");
    expect(slugify("Žluťoučký kůň")).toBe("lu-ou-k-k");
    expect(slugify("日本語")).toBe("skill");
    expect(slugify("smörgåsbord")).toBe("sm-rg-sbord");
  });

  test("returns the 'skill' fallback for empty or separator-only input", () => {
    expect(slugify("")).toBe("skill");
    expect(slugify("   ")).toBe("skill");
    expect(slugify("---")).toBe("skill");
    expect(slugify("!@#$%^&*()")).toBe("skill");
    expect(slugify("日本語")).toBe("skill");
  });

  test("clips to 56 chars, then trims a trailing hyphen exposed by the clip", () => {
    const long = "a".repeat(100);
    expect(slugify(long)).toBe("a".repeat(SLUG_MAX));
    expect(slugify(long).length).toBe(SLUG_MAX);

    // 55 alphanumerics + separators where char 56 (index 55) would be a hyphen:
    // clip keeps "...x-" then trailing-hyphen trim removes it.
    const withTrailingHyphenAtCap = `${"a".repeat(55)} bbbb`;
    const result = slugify(withTrailingHyphenAtCap);
    expect(result).toBe("a".repeat(55));
    expect(result.endsWith("-")).toBe(false);
  });

  test("is idempotent: slugifying an already-slug returns it unchanged", () => {
    for (const slug of [
      "hello-world",
      "skill",
      "a1-b2-c3",
      "foo",
      "abc-123-def",
    ]) {
      expect(slugify(slug)).toBe(slug);
    }
  });

  test("invariant: output is a valid slug and slugify is stable under reapplication", () => {
    const validSlug = /^(skill|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
    const sample = "abcdefghijklmnopqrstuvwxyz0123456789 -_.!@/\\éžñ日";
    const rand = (n: number) => Math.floor(Math.random() * n);

    for (let i = 0; i < 500; i++) {
      let input = "";
      const len = rand(80);
      for (let j = 0; j < len; j++) {
        input += sample[rand(sample.length)];
      }

      const out = slugify(input);

      // Never empty (falls back to "skill").
      expect(out.length).toBeGreaterThan(0);
      // Within the column cap.
      expect(out.length).toBeLessThanOrEqual(SLUG_MAX);
      // Only lowercase alphanumerics and single interior hyphens; no edge hyphens.
      expect(out).toMatch(validSlug);
      // Idempotent: re-slugifying an output is a no-op.
      expect(slugify(out)).toBe(out);
    }
  });
});

describe("collisionSuffix", () => {
  test("is a non-empty base-36 string of at most 7 chars", () => {
    for (let i = 0; i < 50; i++) {
      const suffix = collisionSuffix();
      expect(suffix.length).toBeGreaterThan(0);
      expect(suffix.length).toBeLessThanOrEqual(7);
      expect(suffix).toMatch(/^[0-9a-z]+$/);
    }
  });
});

describe("uniqueSlug", () => {
  test("appends a hyphen-separated collision suffix", () => {
    expect(uniqueSlug("Hello World")).toMatch(/^hello-world-[0-9a-z]{1,7}$/);
  });

  test("uses the 'skill' fallback base when the name slugifies to empty", () => {
    expect(uniqueSlug("日本語")).toMatch(/^skill-[0-9a-z]{1,7}$/);
  });

  test("clips the composed slug to 64 chars", () => {
    const long = "a".repeat(100);
    const out = uniqueSlug(long);
    expect(out.length).toBeLessThanOrEqual(UNIQUE_MAX);
  });
});
