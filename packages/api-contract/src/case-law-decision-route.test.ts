import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";
import { stripDiacriticsForSlug } from "@stll/text-normalize";

import {
  CASE_LAW_DECISION_PATH_MATCH,
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  createCaseLawDecisionSlug,
  extractCaseLawDecisionIdFromIdRouteParam,
  fitCaseLawDecisionSlug,
  isCaseLawDecisionId,
  legacyCaseLawSlug,
  matchCaseLawDecisionPath,
  normalizeCaseLawLanguageSegment,
  parseCaseLawDecisionPath,
} from "./case-law-decision-route";
import type { CaseLawDecisionLanguageAlternate } from "./case-law-decision-route";

const DECISION_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_DECISION_ID = "AZ3UffUHfIS4J5gK8RuJgA";

/** Letters NFKD leaves whole, which the old fold dropped. */
const LETTERS_NFKD_CANNOT_STRIP = [..."łŁđĐøØßæÆœŒþÞðÐıħĦŧŦ"];

/**
 * Characters of published case numbers and court names whose letters
 * decompose (Czech, Slovak, Polish, Hungarian, German, French, Romanian,
 * Turkish), compatibility forms, other scripts, and docket punctuation.
 */
const DECOMPOSING_CHARACTERS = [
  ..."aAzZ09 ./-–()§,:;'\"",
  ..."áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽľĺŕôäĽĹŔÔÄ",
  ..."ąćęńóśźżĄĆĘŃÓŚŹŻőűŐŰöüÖÜàâçèêëîïùûÿ",
  ..."șțăîâȘȚĂğşçİĞŞÇ",
  ..."ﬁﬂ²ＡＺ０\u0301\u030c",
  ..."ΣσжЖ契約",
];

const routeParams = (
  overrides: Partial<Parameters<typeof createCaseLawDecisionRouteParams>[0]>,
) =>
  createCaseLawDecisionRouteParams({
    caseNumber: "20 Cdo 470/2017",
    country: "CZE",
    court: "Nejvyšší soud",
    decisionId: DECISION_ID,
    language: null,
    languageAlternates: null,
    slug: null,
    ...overrides,
  });

describe("createCaseLawDecisionSlug", () => {
  test("normalizes case numbers into stable ASCII slugs", () => {
    expect(createCaseLawDecisionSlug("Nao 66/2026")).toBe("nao-66-2026");
    expect(createCaseLawDecisionSlug("ÚS 10/24")).toBe("us-10-24");
    expect(createCaseLawDecisionSlug("Nejvyšší soud")).toBe("nejvyssi-soud");
    expect(createCaseLawDecisionSlug("  29 Cdo 123/2024  ")).toBe(
      "29-cdo-123-2024",
    );
  });

  // Segments of published decision URLs, under the current fold and under the
  // one before it. Slugs are persisted and links are shared, so a value that
  // decomposes must keep its segment; only letters NFKD cannot strip (`Ł`,
  // `ł`) changed, from a separator to their transliteration.
  test.each([
    ["Pl.ÚS 83/06", "pl-us-83-06", "pl-us-83-06"],
    ["III.ÚS 2900/26", "iii-us-2900-26", "iii-us-2900-26"],
    ["26 Cdo 498/2022", "26-cdo-498-2022", "26-cdo-498-2022"],
    ["22 As 40/2025", "22-as-40-2025", "22-as-40-2025"],
    ["III SA/Łd 223/21", "iii-sa-ld-223-21", "iii-sa-d-223-21"],
    ["III CZP 74/07", "iii-czp-74-07", "iii-czp-74-07"],
    ["C-106/89", "c-106-89", "c-106-89"],
    ["Ústavní soud", "ustavni-soud", "ustavni-soud"],
    ["Nejvyšší správní soud", "nejvyssi-spravni-soud", "nejvyssi-spravni-soud"],
    [
      "Wojewódzki Sąd Administracyjny w Łodzi",
      "wojewodzki-sad-administracyjny-w-lodzi",
      "wojewodzki-sad-administracyjny-w-odzi",
    ],
    [
      "Trybunał Konstytucyjny",
      "trybunal-konstytucyjny",
      "trybuna-konstytucyjny",
    ],
  ])("%s publishes %s, formerly %s", (value, segment, legacySegment) => {
    expect(createCaseLawDecisionSlug(value)).toBe(segment);
    expect(legacyCaseLawSlug(value)).toBe(legacySegment);
  });

  test("the legacy fold reproduces the pre-transliteration fold", () => {
    // An independent spelling of the fold published URLs were minted with:
    // every character outside [a-z0-9] after the NFKD strip separates.
    const preTransliterationFold = (value: string) => {
      let separated = "";
      for (const character of stripDiacriticsForSlug(value).toLowerCase()) {
        separated += /^[a-z0-9]$/u.test(character) ? character : "-";
      }
      return fitCaseLawDecisionSlug({
        baseSlug: separated.split("-").filter(Boolean).join("-"),
      });
    };
    assertProperty(
      "the legacy fold reproduces the pre-transliteration fold",
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.string({ unit: fc.constantFrom(...LETTERS_NFKD_CANNOT_STRIP) }),
        (value, untransliterated) => {
          const mixed = `${value}${untransliterated}${value}`;
          expect(legacyCaseLawSlug(mixed)).toBe(preTransliterationFold(mixed));
        },
      ),
    );
  });

  test("the folds agree on every value whose letters decompose", () => {
    assertProperty(
      "the folds agree on every value whose letters decompose",
      fc.property(
        fc.string({ unit: fc.constantFrom(...DECOMPOSING_CHARACTERS) }),
        (value) => {
          expect(createCaseLawDecisionSlug(value)).toBe(
            legacyCaseLawSlug(value),
          );
        },
      ),
    );
  });

  test("falls back to 'unknown' when nothing alphanumeric remains", () => {
    expect(createCaseLawDecisionSlug("!!!")).toBe("unknown");
    expect(createCaseLawDecisionSlug("")).toBe("unknown");
  });

  test("truncates an expanding case number to the column length", () => {
    // NFKD expands the ligature threefold, past the varchar(256) column.
    expect(createCaseLawDecisionSlug("ﬃ".repeat(256))).toHaveLength(256);
  });

  test("keeps a suffix whole when fitting a slug", () => {
    const fitted = fitCaseLawDecisionSlug({
      baseSlug: "a".repeat(256),
      suffix: "-0123456789abcdef",
    });
    expect(fitted).toHaveLength(256);
    expect(fitted).toMatch(/-0123456789abcdef$/u);
  });

  test("is idempotent, so a stored slug normalizes to itself", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (value) => {
        const slug = createCaseLawDecisionSlug(value);
        expect(createCaseLawDecisionSlug(slug)).toBe(slug);
      }),
      propertyConfig(),
    );
  });
});

describe("matchCaseLawDecisionPath", () => {
  const POLISH_DECISION = {
    caseNumber: "III SA/Łd 223/21",
    country: "POL",
    court: "Wojewódzki Sąd Administracyjny w Łodzi",
    decisionId: DECISION_ID,
    language: null,
    languageAlternates: null,
    slug: null,
  } as const;
  const CANONICAL = {
    country: "pol",
    court: "wojewodzki-sad-administracyjny-w-lodzi",
    slug: `iii-sa-ld-223-21--${COMPACT_DECISION_ID}`,
  };

  test("answers the canonical path as canonical", () => {
    expect(
      matchCaseLawDecisionPath({
        decision: POLISH_DECISION,
        requested: CANONICAL,
      }),
    ).toEqual({ type: CASE_LAW_DECISION_PATH_MATCH.CANONICAL });
  });

  test.each([
    {
      label: "court and id-form prefix",
      decision: POLISH_DECISION,
      requestedSlug: `iii-sa-d-223-21--${COMPACT_DECISION_ID}`,
    },
    {
      // A stored slug is never re-derived, so only the court segment moved.
      label: "court beside a stored slug",
      decision: { ...POLISH_DECISION, slug: "iii-sa-d-223-21" },
      requestedSlug: "iii-sa-d-223-21",
    },
  ])(
    "recognises the $label the old fold published",
    ({ decision, requestedSlug }) => {
      const requested = {
        country: "pol",
        court: "wojewodzki-sad-administracyjny-w-odzi",
        slug: requestedSlug,
      };
      expect(matchCaseLawDecisionPath({ decision, requested })).toEqual({
        type: CASE_LAW_DECISION_PATH_MATCH.LEGACY_FOLD,
        canonical: createCaseLawDecisionRouteParams(decision),
      });
    },
  );

  test("answers any other path with the canonical params, never the request's", () => {
    const requested = {
      country: "pol",
      court: "https:%2F%2Fexample.com",
      slug: `iii-sa-d-223-21--${COMPACT_DECISION_ID}`,
    };
    expect(
      matchCaseLawDecisionPath({ decision: POLISH_DECISION, requested }),
    ).toEqual({
      type: CASE_LAW_DECISION_PATH_MATCH.OTHER,
      canonical: CANONICAL,
    });
  });

  test("a decision with nothing to transliterate has no legacy path", () => {
    const decision = {
      ...POLISH_DECISION,
      caseNumber: "II OSK 12/20",
      court: "Naczelny Sąd Administracyjny",
    };
    const canonical = createCaseLawDecisionRouteParams(decision);
    expect(
      matchCaseLawDecisionPath({ decision, requested: canonical }),
    ).toEqual({ type: CASE_LAW_DECISION_PATH_MATCH.CANONICAL });
    expect(
      matchCaseLawDecisionPath({
        decision,
        requested: { ...canonical, court: "naczelny-sad" },
      }).type,
    ).toBe(CASE_LAW_DECISION_PATH_MATCH.OTHER);
  });
});

describe("createCaseLawDecisionRouteParams", () => {
  test("routes a decision without a stored slug by id, never by case number", () => {
    expect(routeParams({}).slug).toBe(
      `20-cdo-470-2017--${COMPACT_DECISION_ID}`,
    );
  });

  test("prefers stored stable slugs over mutable case-number slugs", () => {
    expect(routeParams({ slug: "  Nějaký právní název  " }).slug).toBe(
      "nejaky-pravni-nazev",
    );
  });

  test("creates structured public route params", () => {
    expect(routeParams({ slug: "ecli-cz-ns-2017-20-cdo" })).toEqual({
      country: "cze",
      court: "nejvyssi-soud",
      slug: "ecli-cz-ns-2017-20-cdo",
    });
  });

  test("routes Hungarian accents and docket punctuation through stable slugs", () => {
    const params = routeParams({
      caseNumber: "Pfv.21.123/2019/5.",
      country: "HUN",
      court: "Fővárosi Ítélőtábla",
      language: "hu",
      slug: "pfv-21-123-2019-5",
    });
    expect(params).toEqual({
      country: "hun",
      court: "fovarosi-itelotabla",
      slug: "pfv-21-123-2019-5",
    });
    expect(parseCaseLawDecisionPath(createCaseLawDecisionPath(params))).toEqual(
      params,
    );
  });

  test("uses the unknown-court segment for a blank court", () => {
    expect(routeParams({ country: "SVK", court: "   " })).toMatchObject({
      country: "svk",
      court: "unknown-court",
    });
  });

  test("does not add a language segment for single-language decisions", () => {
    const params = routeParams({
      language: "cs",
      languageAlternates: [],
      slug: "ecli-cz-ns-2017-20-cdo",
    });

    expect(params).toEqual({
      country: "cze",
      court: "nejvyssi-soud",
      slug: "ecli-cz-ns-2017-20-cdo",
    });
    expect(createCaseLawDecisionPath(params)).toBe(
      "/law/cze/cases/nejvyssi-soud/ecli-cz-ns-2017-20-cdo",
    );
  });

  test("adds a language segment for official multilingual decisions", () => {
    const params = routeParams({
      country: "EUR",
      court: "Court of Justice",
      language: "EN",
      languageAlternates: [{ language: "en" }, { language: "cs" }],
      slug: "c-123-22",
    });

    expect(params).toEqual({
      country: "eur",
      court: "court-of-justice",
      language: "en",
      slug: "c-123-22",
    });
    expect(createCaseLawDecisionPath(params)).toBe(
      "/law/eur/cases/court-of-justice/en/c-123-22",
    );
  });

  test("counts distinct, valid language alternates only", () => {
    const multilingual = (
      language: string,
      languageAlternates: readonly CaseLawDecisionLanguageAlternate[],
    ) =>
      routeParams({ language, languageAlternates, slug: "s" }).language ?? null;

    expect(
      multilingual("CS_CZ", [{ language: "cs-CZ" }, { language: "en" }]),
    ).toBe("cs-cz");
    expect(
      multilingual("cs", [
        { language: "cs" },
        { language: "CS" },
        { language: "en" },
        { language: "??" },
      ]),
    ).toBe("cs");
    expect(
      multilingual("fr", [
        { language: "not a language" },
        { language: "FR" },
        { language: "fr" },
      ]),
    ).toBeNull();
    expect(
      multilingual("not a language", [{ language: "cs" }, { language: "en" }]),
    ).toBeNull();
  });

  test("a slug-less decision's param carries its id; a stored slug is the param", () => {
    const blankSlug = fc.constantFrom(null, "", "   ", "\t\n");
    const storedSlug = fc
      .string({ minLength: 1, maxLength: 300 })
      .filter((slug) => slug.trim() !== "");

    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.uuid(),
        fc.option(storedSlug, { nil: null }),
        blankSlug,
        (caseNumber, decisionId, stored, blank) => {
          const slug = stored ?? blank;
          const param = routeParams({ caseNumber, decisionId, slug }).slug;
          const idFromParam = extractCaseLawDecisionIdFromIdRouteParam(param);

          if (stored === null) {
            expect(idFromParam).toBe(decisionId.toLowerCase());
            return;
          }

          expect(param).toBe(createCaseLawDecisionSlug(stored));
          // A stored slug must not read as an id form.
          expect(idFromParam).toBeNull();
        },
      ),
      propertyConfig(),
    );
  });
});

describe("case-law decision ids", () => {
  test("extracts ids from id-form params, legacy full UUID tails included", () => {
    expect(
      extractCaseLawDecisionIdFromIdRouteParam(
        `20-cdo-470-2017--${COMPACT_DECISION_ID}`,
      ),
    ).toBe(DECISION_ID);
    expect(
      extractCaseLawDecisionIdFromIdRouteParam(
        `20-cdo-470-2017--${DECISION_ID.toUpperCase()}`,
      ),
    ).toBe(DECISION_ID);
    expect(extractCaseLawDecisionIdFromIdRouteParam("20-cdo-470-2017")).toBe(
      null,
    );
  });

  test("splits on the fixed-length tail when the compact id starts with '-'", () => {
    const decisionId = "f8000000-0000-1000-8000-000000000000";
    const param = routeParams({ caseNumber: "", decisionId }).slug;

    expect(param).toBe("unknown---AAAAAAAEACAAAAAAAAAAA");
    expect(extractCaseLawDecisionIdFromIdRouteParam(param)).toBe(decisionId);
  });

  test("distinguishes decision ids from citation numbers", () => {
    expect(isCaseLawDecisionId(DECISION_ID)).toBe(true);
    expect(isCaseLawDecisionId("20 Cdo 470/2017")).toBe(false);
  });
});

describe("normalizeCaseLawLanguageSegment", () => {
  test("normalizes language segments without creating fake locale pages", () => {
    expect(normalizeCaseLawLanguageSegment("PT_BR")).toBe("pt-br");
    expect(normalizeCaseLawLanguageSegment("ZH_HANT")).toBe("zh-hant");
    expect(normalizeCaseLawLanguageSegment("zh-hant-tw")).toBe(null);
    expect(normalizeCaseLawLanguageSegment("not a language")).toBe(null);
  });
});

describe("parseCaseLawDecisionPath", () => {
  const routes = [
    { country: "cze", court: "nejvyssi-soud", slug: "26-cdo-4249-2016" },
    routeParams({ caseNumber: "26 Cdo 4249/2016" }),
    { country: "eu", court: "cjeu", language: "fr", slug: "c-123-20" },
    { country: "eu", court: "cjeu", language: "pt-br", slug: "c-123-20" },
  ];

  test("reads back every path createCaseLawDecisionPath writes", () => {
    for (const params of routes) {
      expect(
        parseCaseLawDecisionPath(createCaseLawDecisionPath(params)),
      ).toEqual(params);
    }
  });

  test("decodes encoded segments", () => {
    expect(
      parseCaseLawDecisionPath("/law/cze/cases/nejvyssi-soud/26%20cdo/"),
    ).toEqual({ country: "cze", court: "nejvyssi-soud", slug: "26 cdo" });
  });

  test("rejects every other path", () => {
    for (const pathname of [
      "/law/cze/statutes/89-2012",
      "/law/cze/cases/nejvyssi-soud",
      "/law/cze/cases/nejvyssi-soud/a/b/c",
      "/law/cze/cases/nejvyssi-soud/Not-A-Language/slug",
      "/law/cze/cases/nejvyssi-soud/1234567890/slug",
      "/workspaces/abc",
      "/law/cze/cases/nejvyssi-soud/%E0%A4%A",
      "/",
    ]) {
      expect(parseCaseLawDecisionPath(pathname)).toBeNull();
    }
  });
});
