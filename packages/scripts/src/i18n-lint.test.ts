import { describe, expect, test } from "bun:test";

import { LOCALES, parseGlossary } from "./glossary-gen";
import {
  buildForbiddenRules,
  findDroppedPlurals,
  findForbiddenTerms,
  findIcuError,
  findMissingPluralCategories,
  findPlaceholderMismatch,
  isSuppressed,
} from "./i18n-lint";
import type { LintBaseline } from "./i18n-lint";

describe("findPlaceholderMismatch", () => {
  test("returns null when the variable sets match (order is irrelevant)", () => {
    expect(
      findPlaceholderMismatch("Hi {name}, {count}", "{count} – {name}"),
    ).toBeNull();
  });

  test("flags a dropped variable", () => {
    expect(findPlaceholderMismatch("Sent to {email}", "Odesláno")).toEqual({
      missing: ["email"],
      extra: [],
    });
  });

  test("flags a renamed variable as both missing and extra", () => {
    expect(findPlaceholderMismatch("{a}", "{b}")).toEqual({
      missing: ["a"],
      extra: ["b"],
    });
  });

  test("tracks rich-text tag names (t.rich), not just their children", () => {
    expect(
      findPlaceholderMismatch("<terms>Terms</terms>", "<link>Podmínky</link>"),
    ).toEqual({ missing: ["<terms>"], extra: ["<link>"] });
  });

  test("counts the plural argument, not the # placeholder", () => {
    expect(
      findPlaceholderMismatch(
        "{count, plural, one {# item} other {# items}}",
        "{count, plural, one {# položka} few {# položky} other {# položek}}",
      ),
    ).toBeNull();
  });
});

describe("findIcuError", () => {
  test("returns null for valid ICU", () => {
    expect(findIcuError("{count, plural, one {#} other {#}}")).toBeNull();
  });

  test("returns a message for broken ICU", () => {
    expect(findIcuError("{count, plural, one {#}")).not.toBeNull();
  });
});

describe("findMissingPluralCategories", () => {
  test("flags Polish missing few/many for an English-shaped plural", () => {
    expect(
      findMissingPluralCategories("{n, plural, one {#} other {#}}", "pl"),
    ).toEqual(expect.arrayContaining(["n#few", "n#many"]));
  });

  test("passes when the locale needs only the present categories", () => {
    expect(
      findMissingPluralCategories("{n, plural, one {#} other {#}}", "de"),
    ).toEqual([]);
  });

  test("does not require cs/sk fractional-only `many` for integer UI counts", () => {
    expect(
      findMissingPluralCategories(
        "{n, plural, one {#} few {#} other {#}}",
        "cs",
      ),
    ).toEqual([]);
  });

  test("does not count exact selectors like =0 toward CLDR categories", () => {
    expect(
      findMissingPluralCategories(
        "{n, plural, =0 {none} one {#} other {#}}",
        "en",
      ),
    ).toEqual([]);
  });
});

describe("findDroppedPlurals", () => {
  test("flags a source plural flattened to plain interpolation", () => {
    expect(
      findDroppedPlurals("{count, plural, one {#} other {#}}", "{count} items"),
    ).toEqual(["count"]);
  });

  test("passes when the target keeps the plural", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {#} other {#}}",
        "{count, plural, one {#} few {#} other {#}}",
      ),
    ).toEqual([]);
  });
});

describe("isSuppressed", () => {
  const baseline: LintBaseline = {
    placeholder: { "a.b": { cs: "grandfathered value" } },
    icu: {},
    plural: {},
    terminology: {},
  };

  test("suppresses only when the offending value is unchanged", () => {
    expect(
      isSuppressed(baseline, "placeholder", "a.b", "cs", "grandfathered value"),
    ).toBe(true);
  });

  test("re-checks once the grandfathered string is edited", () => {
    expect(
      isSuppressed(baseline, "placeholder", "a.b", "cs", "edited value"),
    ).toBe(false);
  });
});

describe("terminology", () => {
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [
          {
            id: "matter",
            en: "Matter",
            forbidden: { de: ["Sache"] },
            translations: fill("x"),
          },
        ],
        ptBR: [],
      }),
    ),
  );

  test("flags a forbidden rendering when the source is about the concept", () => {
    expect(
      findForbiddenTerms("Open this matter", "Diese Sache öffnen", "de", rules),
    ).toEqual(["Sache"]);
  });

  test("does not fire when the source is unrelated to the concept", () => {
    expect(
      findForbiddenTerms("A factual question", "Eine reine Sache", "de", rules),
    ).toEqual([]);
  });

  test("matches whole words only (no substring false positives)", () => {
    expect(
      findForbiddenTerms("Open this matter", "Sachenrecht gilt", "de", rules),
    ).toEqual([]);
  });
});
