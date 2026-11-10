import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import {
  getMatterColor,
  getMatterPickerColor,
  getMatterSwatch,
  getTopicColor,
  getTopicSwatch,
  MATTER_SWATCHES,
  resolveMatterColor,
  TOPIC_SWATCHES,
  toStoredMatterColor,
} from "./matter-colors";

describe("getMatterSwatch", () => {
  test("always returns the same swatch for the same id (deterministic hash)", () => {
    const id = "matter-abc-123";
    expect(getMatterSwatch(id)).toBe(getMatterSwatch(id));
  });

  test("returned swatch is within MATTER_SWATCHES", () => {
    for (const id of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      expect(MATTER_SWATCHES).toContain(getMatterSwatch(id));
    }
  });

  test("different ids spread across multiple swatches", () => {
    const seen = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(getMatterSwatch),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("getMatterColor", () => {
  test("wraps the swatch in a CSS var() expression", () => {
    const id = "some-matter";
    expect(getMatterColor(id)).toBe(`var(${getMatterSwatch(id)})`);
  });
});

describe("getMatterPickerColor", () => {
  test("returns the swatch name (without --option- prefix) when color is null", () => {
    const swatch = getMatterSwatch("picker-id");
    const expected = swatch.slice("--option-".length);
    expect(getMatterPickerColor("picker-id", null)).toBe(expected);
  });

  test("strips # from a hex color", () => {
    expect(getMatterPickerColor("any-id", "#A1B2C3")).toBe("A1B2C3");
  });

  test("strips --option- prefix from a CSS-var token", () => {
    expect(getMatterPickerColor("any-id", "--option-violet")).toBe("violet");
  });
});

describe("toStoredMatterColor", () => {
  test("normalises a hex color to uppercase with # prefix", () => {
    expect(toStoredMatterColor("a1b2c3")).toBe("#A1B2C3");
    expect(toStoredMatterColor("#a1b2c3")).toBe("#A1B2C3");
  });

  test("returns --option-* tokens unchanged", () => {
    expect(toStoredMatterColor("--option-emerald")).toBe("--option-emerald");
  });

  test("prepends --option- to bare color names", () => {
    expect(toStoredMatterColor("cyan")).toBe("--option-cyan");
  });
});

describe("resolveMatterColor — round-trip with toStoredMatterColor", () => {
  test("hex input round-trips through storage and resolution", () => {
    const stored = toStoredMatterColor("FF5733");
    expect(resolveMatterColor("id", stored)).toBe("#FF5733");
  });

  test("CSS-var token resolves to var() form", () => {
    expect(resolveMatterColor("id", "--option-teal")).toBe(
      "var(--option-teal)",
    );
  });

  test("bare color name resolves to var(--option-*)", () => {
    expect(resolveMatterColor("id", "orange")).toBe("var(--option-orange)");
  });

  test("falls back to id-hash color when color is null", () => {
    const id = "fallback-id";
    expect(resolveMatterColor(id, null)).toBe(getMatterColor(id));
  });
});

const THEME = readFileSync(
  path.join(import.meta.dir, "../styles/theme.css"),
  "utf-8",
);

/** Every `--name: value;` a top-level rule of theme.css sets, by selector. */
const themeDeclarations = (prefix: string) =>
  [...THEME.matchAll(/^([^\s{}@/][^{}]*)\{([^{}]*)\}/gmu)].flatMap(
    ([, selector = "", body = ""]) =>
      [...body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)]
        .filter(([, name = ""]) => name.startsWith(prefix))
        .map(([, name = "", value = ""]) => ({
          name,
          selector: selector.trim(),
          value: value.trim(),
        })),
  );

/** The colour names a stored matter colour can take: every option swatch. */
const OPTION_NAMES = [
  ...new Set(
    themeDeclarations("--option-")
      .map(({ name }) => name.slice("--option-".length))
      .filter((name) => !name.endsWith("-bg") && !name.endsWith("-fg")),
  ),
];

/** Topics stay well under the chroma of any colour a matter can be. */
const TOPIC_MAX_CHROMA = 0.05;

describe("topic swatches", () => {
  test("one topic key always picks the same swatch from the topic set", () => {
    for (const key of ["title:lease.docx", "app:com.example.mail", "x"]) {
      expect(getTopicSwatch(key)).toBe(getTopicSwatch(key));
      expect(TOPIC_SWATCHES).toContain(getTopicSwatch(key));
      expect(getTopicColor(key)).toBe(`var(${getTopicSwatch(key)})`);
    }
    const spread = new Set(
      Array.from({ length: 40 }, (_, index) => getTopicSwatch(`t${index}`)),
    );
    expect(spread.size).toBe(TOPIC_SWATCHES.length);
  });

  test("topic tones never equal a matter tone", () => {
    expect(OPTION_NAMES.length).toBeGreaterThan(MATTER_SWATCHES.length);
    const storedColor = fc.oneof(
      fc.constant(null),
      fc.constantFrom(...OPTION_NAMES),
      fc.constantFrom(...OPTION_NAMES.map((name) => `--option-${name}`)),
      fc
        .integer({ min: 0, max: 0xff_ff_ff })
        .map((value) => `#${value.toString(16).padStart(6, "0")}`),
    );
    assertProperty(
      "topic tones never equal a matter tone",
      fc.property(
        fc.string(),
        fc.string(),
        storedColor,
        (topicKey, matterId, color) => {
          expect(getTopicColor(topicKey)).not.toBe(
            resolveMatterColor(matterId, color),
          );
        },
      ),
    );
  });

  test("every topic token is set for light and dark, in low chroma, and differs from every matter swatch", () => {
    const topics = themeDeclarations("--topic-");
    const optionValues = new Set(
      themeDeclarations("--option-").map(({ value }) => value),
    );
    for (const selector of [":root", ".dark"]) {
      expect(
        topics
          .filter((topic) => topic.selector === selector)
          .map(({ name }) => name)
          .toSorted(),
      ).toEqual([...TOPIC_SWATCHES].toSorted());
    }
    for (const { value } of topics) {
      // A token that is not a plain oklch() reads as NaN and fails.
      const chroma = Number(
        /^oklch\(\s*[\d.]+\s+([\d.]+)\s+[\d.]+\s*\)$/u.exec(value)?.[1],
      );
      expect(chroma).toBeLessThanOrEqual(TOPIC_MAX_CHROMA);
      expect(optionValues.has(value)).toBe(false);
    }
  });
});
