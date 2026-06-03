import { describe, expect, test } from "bun:test";

import {
  type CaseLawDecisionSearchHit,
  createCaseLawDecisionRouteParams,
  createCaseLawDecisionRouteParam,
  createCaseLawDecisionPath,
  createStableCaseLawSlug,
  decodeCaseLawDecisionRef,
  decodeCaseLawDecisionIdFromRoute,
  encodeCaseLawDecisionIdForRoute,
  extractCaseLawDecisionIdFromRouteParam,
  extractLegacyCaseLawDecisionIdFromRouteParam,
  isCaseLawDecisionId,
  normalizeCaseLawLanguageSegment,
  normalizeCaseLawStoredSlug,
  pickCaseLawDecisionHit,
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
  test("creates stable slugged route params", () => {
    expect(slugifyCaseLawCaseNumber("20 Cdo 470/2017")).toBe("20-cdo-470-2017");
    expect(
      createCaseLawDecisionRouteParam({
        caseNumber: "20 Cdo 470/2017",
      }),
    ).toBe("20-cdo-470-2017");
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
      createStableCaseLawSlug({
        caseNumber: "22 Azs 285/2025",
        slug: "Nao 66 2026",
      }),
    ).toBe("nao-66-2026");
    expect(
      createCaseLawDecisionRouteParam({
        caseNumber: "22 Azs 285/2025",
        slug: "Nao 66 2026",
      }),
    ).toBe("nao-66-2026");
  });

  test("creates structured public route params", () => {
    expect(
      createCaseLawDecisionRouteParams({
        caseNumber: "20 Cdo 470/2017",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2017-09-20",
        decisionId: DECISION_ID,
        slug: "ecli-cz-ns-2017-20-cdo",
      }),
    ).toEqual({
      country: "cze",
      court: "nejvyssi-soud",
      date: "2017-09-20",
      slug: "ecli-cz-ns-2017-20-cdo",
    });
  });

  test("does not add language route params for ordinary single-language decisions", () => {
    const params = createCaseLawDecisionRouteParams({
      caseNumber: "20 Cdo 470/2017",
      country: "CZE",
      court: "Nejvyšší soud",
      decisionDate: "2017-09-20",
      decisionId: DECISION_ID,
      language: "cs",
      languageAlternates: [],
      slug: "ecli-cz-ns-2017-20-cdo",
    });

    expect(params).toEqual({
      country: "cze",
      court: "nejvyssi-soud",
      date: "2017-09-20",
      slug: "ecli-cz-ns-2017-20-cdo",
    });
    expect(createCaseLawDecisionPath(params)).toBe(
      "/law/cze/cases/nejvyssi-soud/2017-09-20/ecli-cz-ns-2017-20-cdo",
    );
  });

  test("adds language route params for official multilingual decisions", () => {
    const params = createCaseLawDecisionRouteParams({
      caseNumber: "C-123/22",
      country: "EUR",
      court: "Court of Justice",
      decisionDate: "2024-03-07",
      decisionId: DECISION_ID,
      language: "EN",
      languageAlternates: [{ language: "en" }, { language: "cs" }],
      slug: "c-123-22",
    });

    expect(params).toEqual({
      country: "eur",
      court: "court-of-justice",
      date: "2024-03-07",
      language: "en",
      slug: "c-123-22",
    });
    expect(createCaseLawDecisionPath(params)).toBe(
      "/law/eur/cases/court-of-justice/2024-03-07/en/c-123-22",
    );
  });

  test("normalizes language segments without creating fake locale pages", () => {
    expect(normalizeCaseLawLanguageSegment("PT_BR")).toBe("pt-br");
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
        caseNumber: "C-123/22",
        country: "EUR",
        court: "Court of Justice",
        decisionDate: "2024-03-07",
        decisionId: DECISION_ID,
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
      date: "2024-03-07",
      slug: "c-123-22",
    });
  });

  test("uses explicit case-law language alternate counts from public APIs", () => {
    expect(
      createCaseLawDecisionRouteParams({
        caseNumber: "C-123/22",
        country: "EUR",
        court: "Court of Justice",
        decisionDate: "2024-03-07",
        decisionId: DECISION_ID,
        language: "EN",
        languageAlternateCount: 2,
        slug: "c-123-22",
      }),
    ).toEqual({
      country: "eur",
      court: "court-of-justice",
      date: "2024-03-07",
      language: "en",
      slug: "c-123-22",
    });
  });

  test("uses stable fallbacks for missing public route metadata", () => {
    expect(
      createCaseLawDecisionRouteParams({
        caseNumber: "20 Cdo 470/2017",
        country: "SVK",
        court: "",
        decisionDate: null,
        decisionId: DECISION_ID,
      }),
    ).toMatchObject({
      country: "svk",
      court: "unknown-court",
      date: "unknown-date",
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
      extractLegacyCaseLawDecisionIdFromRouteParam(
        `20-cdo-470-2017--${COMPACT_DECISION_ID}`,
      ),
    ).toBe(DECISION_ID);
    expect(
      extractLegacyCaseLawDecisionIdFromRouteParam("20-cdo-470-2017"),
    ).toBe(null);
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
