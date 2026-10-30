import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { foldToAscii } from "./ascii-fold";
import { ASCII_FOLD_TABLE } from "./ascii-fold-table";
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

  test.each([
    ["café", "cafe"],
    ["Řeč", "rec"],
    [
      "Wojewódzki Sąd Administracyjny w Łodzi",
      "wojewodzki-sad-administracyjny-w-lodzi",
    ],
    ["Trybunał Konstytucyjny", "trybunal-konstytucyjny"],
    ["Đakovo", "dakovo"],
    ["Højesteret", "hojesteret"],
    ["Bundesgerichtshof Straße", "bundesgerichtshof-strasse"],
    ["Æsir Œuvre", "aesir-oeuvre"],
    ["Þingvellir Ða", "thingvellir-da"],
    ["Diyarbakır", "diyarbakir"],
    ["Ħamrun ŧ", "hamrun-t"],
    ["ﬁnal Ａ", "final-a"],
  ])("transliterates %s to %s under the ascii charset", (value, slug) => {
    expect(slugify(value, { ...ascii, maxLength: 80 })).toBe(slug);
  });

  test("keeps letters and numbers of any script under the unicode charset", () => {
    expect(
      slugify("Tomasz Nowicki", {
        charset: "unicode",
        separator: "_",
        maxLength: 40,
        fallback: "field",
      }),
    ).toBe("tomasz_nowicki");
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

/**
 * Every letter the fold table names, letters that decompose, letters of other
 * scripts, a lone combining mark, and separators.
 */
const SLUG_CHARACTERS = [
  ...Object.keys(ASCII_FOLD_TABLE),
  ..."aZ09áčěŘšůžőűİΣжم契 -/.\u0301".split(""),
];

const slugText = fc
  .array(fc.constantFrom(...SLUG_CHARACTERS), { maxLength: 24 })
  .map((parts) => parts.join(""));

const ASCII_ALPHANUMERICS = /^[a-z0-9]+$/u;
const LETTER = /^\p{L}$/u;

test("ascii slugs keep every Latin letter's transliteration", () => {
  assertProperty(
    "ascii slugs keep every Latin letter's transliteration",
    fc.property(slugText, (value) => {
      const slug = slugify(value, {
        charset: "ascii",
        separator: "-",
        maxLength: Number.MAX_SAFE_INTEGER,
        fallback: "",
      });
      expect(slug).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/u);
      for (const character of value) {
        // The search fold is the oracle: what it spells in ASCII, the slug
        // must keep rather than drop.
        const spelled = foldToAscii(character).toLowerCase();
        if (LETTER.test(character) && ASCII_ALPHANUMERICS.test(spelled)) {
          expect(slug).toContain(spelled);
        }
      }
    }),
  );
});
