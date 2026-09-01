import { describe, expect, test } from "bun:test";

import {
  type CaseLawDecisionSearchHit,
  createCaseLawDecisionRouteParams,
  createCaseLawDecisionRouteParam,
  createCaseLawDecisionPath,
  decodeCaseLawDecisionRef,
  decodeCaseLawDecisionIdFromRoute,
  encodeCaseLawDecisionIdForRoute,
  extractCaseLawDecisionIdFromIdRouteParam,
  extractCaseLawDecisionIdFromRouteParam,
  isCaseLawDecisionId,
  normalizeCaseLawLanguageSegment,
  normalizeCaseLawStoredSlug,
  pickCaseLawDecisionHit,
  resolveCaseLawDecisionRouteIdentity,
  shouldUseCaseLawLanguageSegment,
  slugifyCaseLawCaseNumber,
} from "@/lib/case-law-route";

const DECISION_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_DECISION_ID = "AZ3UffUHfIS4J5gK8RuJgA";

const caseLawHit = ({
  caseNumber,
  decisionId,
}: {
  caseNumber: string;
  decisionId: string;
}): CaseLawDecisionSearchHit => ({
  caseNumber,
  country: "CZE",
  court: "Nejvyssi soud",
  decisionDate: "2024-01-31",
  decisionId,
  ecli: null,
});

describe("case-law decision routes", () => {
  test("routes a decision without a stored slug by id, never by case number", () => {
    expect(slugifyCaseLawCaseNumber("20 Cdo 470/2017")).toBe("20-cdo-470-2017");
    expect(
      createCaseLawDecisionRouteParam({
        caseNumber: "20 Cdo 470/2017",
        decisionId: DECISION_ID,
      }),
    ).toBe(`20-cdo-470-2017--${COMPACT_DECISION_ID}`);
  });

  test("decodes legacy UUID route suffixes compactly for redirects", () => {
    expect(encodeCaseLawDecisionIdForRoute(DECISION_ID)).toBe(
      COMPACT_DECISION_ID,
    );
    expect(decodeCaseLawDecisionIdFromRoute(COMPACT_DECISION_ID)).toBe(
      DECISION_ID,
    );
    expect(decodeCaseLawDecisionIdFromRoute(DECISION_ID.toUpperCase())).toBe(
      DECISION_ID,
    );
  });

  test("prefers stored stable slugs over mutable case-number slugs", () => {
    expect(normalizeCaseLawStoredSlug("  Nějaký právní název  ")).toBe(
      "nejaky-pravni-nazev",
    );
    expect(
      createCaseLawDecisionRouteParam({
        caseNumber: "22 Azs 285/2025",
        decisionId: DECISION_ID,
        slug: "Nao 66 2026",
      }),
    ).toBe("nao-66-2026");
  });

  test("creates structured public route params", () => {
    expect(
      createCaseLawDecisionRouteParams({
        decisionId: DECISION_ID,
        caseNumber: "20 Cdo 470/2017",
        country: "CZE",
        court: "Nejvyšší soud",
        slug: "ecli-cz-ns-2017-20-cdo",
      }),
    ).toEqual({
      country: "cze",
      court: "nejvyssi-soud",
      slug: "ecli-cz-ns-2017-20-cdo",
    });
  });

  test("does not add language route params for ordinary single-language decisions", () => {
    const params = createCaseLawDecisionRouteParams({
      decisionId: DECISION_ID,
      caseNumber: "20 Cdo 470/2017",
      country: "CZE",
      court: "Nejvyšší soud",
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

  test("adds language route params for official multilingual decisions", () => {
    const params = createCaseLawDecisionRouteParams({
      decisionId: DECISION_ID,
      caseNumber: "C-123/22",
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

  test("normalizes language segments without creating fake locale pages", () => {
    expect(normalizeCaseLawLanguageSegment("PT_BR")).toBe("pt-br");
    expect(normalizeCaseLawLanguageSegment("ZH_HANT")).toBe("zh-hant");
    expect(normalizeCaseLawLanguageSegment("zh-hant-tw")).toBe(null);
    expect(normalizeCaseLawLanguageSegment("not a language")).toBe(null);
    expect(
      shouldUseCaseLawLanguageSegment({
        language: "cs",
        languageAlternates: [{ language: "cs" }],
      }),
    ).toBe(false);
    expect(
      shouldUseCaseLawLanguageSegment({
        language: "cs",
        languageAlternates: [{ language: "cs" }, { language: "en" }],
      }),
    ).toBe(true);
  });

  test("does not create case-law language URLs from duplicate or invalid alternates", () => {
    expect(
      shouldUseCaseLawLanguageSegment({
        language: "fr",
        languageAlternates: [
          { language: "not a language" },
          { language: "FR" },
          { language: "fr" },
        ],
      }),
    ).toBe(false);

    expect(
      createCaseLawDecisionRouteParams({
        decisionId: DECISION_ID,
        caseNumber: "C-123/22",
        country: "EUR",
        court: "Court of Justice",
        language: "FR",
        languageAlternates: [
          { language: "not a language" },
          { language: "FR" },
          { language: "fr" },
        ],
        slug: "c-123-22",
      }),
    ).toEqual({
      country: "eur",
      court: "court-of-justice",
      slug: "c-123-22",
    });
  });

  test("uses stable fallbacks for missing public route metadata", () => {
    expect(
      createCaseLawDecisionRouteParams({
        decisionId: DECISION_ID,
        caseNumber: "20 Cdo 470/2017",
        country: "SVK",
        court: "",
      }),
    ).toMatchObject({
      country: "svk",
      court: "unknown-court",
    });
  });

  test("extracts persisted decision ids from public route params", () => {
    expect(
      extractCaseLawDecisionIdFromRouteParam(
        `20-cdo-470-2017--${COMPACT_DECISION_ID}`,
      ),
    ).toBe(DECISION_ID);
    expect(extractCaseLawDecisionIdFromRouteParam(DECISION_ID)).toBe(
      DECISION_ID,
    );
    expect(
      extractCaseLawDecisionIdFromIdRouteParam(
        `20-cdo-470-2017--${COMPACT_DECISION_ID}`,
      ),
    ).toBe(DECISION_ID);
    expect(extractCaseLawDecisionIdFromIdRouteParam("20-cdo-470-2017")).toBe(
      null,
    );
  });

  test("every decision's route param round-trips to its own identity", () => {
    // The input class the route layer must survive: case numbers of every
    // shape the corpus holds, with and without a stored slug.
    const caseNumbers = [
      "20 Cdo 470/2017",
      "III.ÚS 4129/18",
      "Pl.ÚS-st. 45/16",
      "C-123/22",
      "8 Azs 10/2024 - 35",
      "   ",
      "--",
      "1 T 5/2020--x",
    ];
    const slugs = [null, undefined, "", "  ", "stored-slug", "Nao 66 2026"];
    const ids = [
      DECISION_ID,
      "0198f8a3-2c1d-7a4b-8f2e-1b7c9d3e5a61",
      "00000000-0000-7000-8000-000000000000",
    ];

    for (const caseNumber of caseNumbers) {
      for (const slug of slugs) {
        for (const decisionId of ids) {
          const identity = resolveCaseLawDecisionRouteIdentity({
            caseNumber,
            decisionId,
            slug,
          });
          // The expected branch comes from the fixture, not the resolver:
          // only a stored, non-blank slug may route by slug.
          const expectedKind =
            typeof slug === "string" && slug.trim() !== "" ? "slug" : "id";
          expect(identity.kind).toBe(expectedKind);
          const param = createCaseLawDecisionRouteParam({
            caseNumber,
            decisionId,
            slug,
          });
          const idFromParam = extractCaseLawDecisionIdFromIdRouteParam(param);

          switch (identity.kind) {
            case "slug": {
              // A stored slug is the route param; the loader resolves it
              // by slug and must not mistake it for an id form.
              expect(param).toBe(identity.slug);
              expect(idFromParam).toBe(null);
              break;
            }
            case "id": {
              // No stored slug: the param carries the id, so the loader
              // resolves by id and finds the canonical param unchanged.
              expect(idFromParam).toBe(decisionId);
              expect(
                createCaseLawDecisionRouteParam({
                  caseNumber,
                  decisionId,
                  slug: null,
                }),
              ).toBe(param);
              break;
            }
            default: {
              const exhaustive: never = identity;
              throw new Error(String(exhaustive));
            }
          }
        }
      }
    }
  });

  test("decodes markdown href payloads that contain case numbers", () => {
    expect(decodeCaseLawDecisionRef("20%20Cdo%20470%2F2017")).toBe(
      "20 Cdo 470/2017",
    );
    expect(decodeCaseLawDecisionRef("20 Cdo 470/2017")).toBe("20 Cdo 470/2017");
  });

  test("distinguishes decision ids from citation numbers", () => {
    expect(isCaseLawDecisionId(DECISION_ID)).toBe(true);
    expect(isCaseLawDecisionId("20 Cdo 470/2017")).toBe(false);
  });

  test("prefers exact case number matches over first search result", () => {
    const hit = pickCaseLawDecisionHit("20 Cdo 470/2017", [
      caseLawHit({
        caseNumber: "20 Cdo 999/2017",
        decisionId: "019dd47e-2d83-7178-8f24-11f2976a01db",
      }),
      caseLawHit({ caseNumber: "20 Cdo 470/2017", decisionId: DECISION_ID }),
    ]);

    expect(hit?.decisionId).toBe(DECISION_ID);
  });
});
