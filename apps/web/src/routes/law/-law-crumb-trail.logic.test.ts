import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { decisionDateRange } from "@/features/case-law/case-law-index-search.logic";
import { toSafeId } from "@/lib/safe-id";
import { LAW_CRUMB_TRAIL_PRODUCERS } from "@/routes/law/-law-crumb-trail";
import {
  decisionLawCrumbTrailOf,
  statuteLawCrumbTrailOf,
} from "@/routes/law/-law-crumb-trail.logic";
import { searchSchema } from "@/routes/law/cases/-case-law-search-schema";

const decisionId = (id: string) => toSafeId<"caseLawDecision">(id);
const caseFileDocument = (id: string, languageGroupKey: string | null) => ({
  id: decisionId(id),
  caseNumber: "SYN 1/2026",
  country: "CZE",
  court: "Synthetic court",
  decisionDate: "2026-01-29",
  decisionType: "rozsudek",
  ecli: null,
  language: "cs",
  languageAlternates: [],
  languageGroupKey,
  slug: id,
});
const EMPTY_CASE_FILE = { items: [], nextCursor: null, limit: 50 };
// The identity every fixture's open decision shares.
const OPEN_DECISION = {
  caseFile: EMPTY_CASE_FILE,
  id: decisionId("open"),
  languageGroupKey: null,
};

describe("statute breadcrumb identity and destinations", () => {
  test("separates a Czech citation from its short title and retains the full title", () => {
    const statute = {
      status: "current",
      versionValidFrom: "2012-01-01",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      eli: "/eli/cz/sb/2012/89",
      title: "89/2012 Sb., občanský zákoník",
      country: "CZE",
    } satisfies Parameters<typeof statuteLawCrumbTrailOf>[0];

    expect(statuteLawCrumbTrailOf(statute)).toEqual({
      kind: "statute",
      status: statute.status,
      validFrom: statute.versionValidFrom,
      expression: {
        expressionKind: statute.expressionKind,
        windowDisposition: statute.windowDisposition,
      },
      identity: { kind: "statute", number: "89", year: "2012" },
      citation: "89/2012 Sb.",
      shortTitle: "občanský zákoník",
      fullTitle: statute.title,
      yearLink: {
        year: 2012,
        link: {
          to: "/law/$country/statutes",
          params: { country: "cze" },
          search: { year: 2012 },
        },
      },
    });
  });

  test("omits a short title when the title contains only the citation", () => {
    const statute = {
      status: "current",
      versionValidFrom: "2012-01-01",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      eli: "/eli/cz/sm/2012/89",
      title: "89/2012 Sb. m. s.",
      country: "CZE",
    } satisfies Parameters<typeof statuteLawCrumbTrailOf>[0];

    expect(statuteLawCrumbTrailOf(statute)).toMatchObject({
      citation: "89/2012 Sb. m. s.",
      shortTitle: null,
      fullTitle: statute.title,
    });
  });

  test.each([
    { year: "1964", number: "40", gazette: "Zb." },
    { year: "2015", number: "300", gazette: "Z. z." },
  ])(
    "uses the Slovak gazette and country route for $year",
    ({ year, number, gazette }) => {
      const statute = {
        status: "current",
        versionValidFrom: "2012-01-01",
        expressionKind: "consolidation",
        windowDisposition: "effective",
        eli: `/eli/sk/zz/${year}/${number}`,
        title: "Občiansky zákonník",
        country: "SVK",
      } satisfies Parameters<typeof statuteLawCrumbTrailOf>[0];

      expect(statuteLawCrumbTrailOf(statute)).toEqual({
        kind: "statute",
        status: statute.status,
        validFrom: statute.versionValidFrom,
        expression: {
          expressionKind: statute.expressionKind,
          windowDisposition: statute.windowDisposition,
        },
        identity: { kind: "statute", number, year },
        citation: `${number}/${year} ${gazette}`,
        shortTitle: statute.title,
        fullTitle: `${number}/${year} ${gazette} ${statute.title}`,
        yearLink: {
          year: Number(year),
          link: {
            to: "/law/$country/statutes",
            params: { country: "svk" },
            search: { year: Number(year) },
          },
        },
      });
    },
  );

  test("omits the year destination when the ELI carries no act year", () => {
    const statute = {
      status: "current",
      versionValidFrom: "2012-01-01",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      eli: "CZ/2012/89",
      title: "občanský zákoník",
      country: "CZE",
    } satisfies Parameters<typeof statuteLawCrumbTrailOf>[0];

    expect(statuteLawCrumbTrailOf(statute)).toEqual({
      kind: "statute",
      status: statute.status,
      validFrom: statute.versionValidFrom,
      expression: {
        expressionKind: statute.expressionKind,
        windowDisposition: statute.windowDisposition,
      },
      identity: { kind: "statute", number: null, year: null },
      citation: null,
      shortTitle: statute.title,
      fullTitle: statute.title,
      yearLink: null,
    });
  });
});

describe("decision breadcrumb identity and destinations", () => {
  test("retains the court, case number and legal area and scopes the year to the court", () => {
    const decision = {
      ...OPEN_DECISION,
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      courtTier: "supreme",
      caseNumber: "23 Cdo 123/2024",
      decisionDate: "2024-06-17",
      metadata: { legalArea: "Občanské právo" },
    } satisfies Parameters<typeof decisionLawCrumbTrailOf>[0];

    expect(decisionLawCrumbTrailOf(decision)).toEqual({
      kind: "decision",
      court: {
        name: decision.court,
        abbreviation: "NS",
        tier: "supreme",
        link: { to: "/law/cases", search: { court: decision.court } },
      },
      yearLink: {
        year: 2024,
        link: {
          to: "/law/cases",
          search: {
            court: decision.court,
            from: "2024-01-01",
            to: "2024-12-31",
          },
        },
      },
      caseNumber: decision.caseNumber,
      caseFile: null,
      legalArea: "Občanské právo",
    });
  });

  test("links the year to a search the results page reads as that whole year", () => {
    const trail = decisionLawCrumbTrailOf({
      ...OPEN_DECISION,
      court: "Ústavní soud",
      courtAbbreviation: "ÚS",
      caseNumber: "III.ÚS 290/26",
      decisionDate: "2026-03-02",
      metadata: {},
    });
    const search = v.parse(searchSchema, trail.yearLink?.link.search);

    expect(search).toMatchObject({ court: "Ústavní soud" });
    expect(decisionDateRange(search)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  test("keeps the court destination when the date, abbreviation, tier and legal area are absent", () => {
    const decision = {
      ...OPEN_DECISION,
      court: "Synthetic court",
      courtAbbreviation: null,
      caseNumber: "SYN 1/2026",
      decisionDate: null,
      metadata: {},
    } satisfies Parameters<typeof decisionLawCrumbTrailOf>[0];

    expect(decisionLawCrumbTrailOf(decision)).toEqual({
      kind: "decision",
      court: {
        name: decision.court,
        abbreviation: null,
        tier: undefined,
        link: { to: "/law/cases", search: { court: decision.court } },
      },
      yearLink: null,
      caseNumber: decision.caseNumber,
      caseFile: null,
      legalArea: null,
    });
  });

  test("offers the case file only when it holds a document besides the open one", () => {
    const decision = {
      ...OPEN_DECISION,
      court: "Synthetic court",
      courtAbbreviation: null,
      caseNumber: "SYN 1/2026",
      decisionDate: null,
      metadata: {},
    } satisfies Parameters<typeof decisionLawCrumbTrailOf>[0];
    const open = caseFileDocument("open", null);
    const appeal = caseFileDocument("appeal", null);

    expect(
      decisionLawCrumbTrailOf({
        ...decision,
        caseFile: { ...EMPTY_CASE_FILE, items: [open] },
      }).caseFile,
    ).toBeNull();
    expect(
      decisionLawCrumbTrailOf({
        ...decision,
        caseFile: { ...EMPTY_CASE_FILE, items: [open, appeal] },
      }).caseFile,
    ).toEqual({
      ...EMPTY_CASE_FILE,
      items: [open, appeal],
      current: { id: OPEN_DECISION.id, languageGroupKey: null },
    });
  });

  test.each([
    { legalArea: 42 },
    { legalArea: false },
    { legalArea: ["Civil law"] },
    { legalArea: { name: "Civil law" } },
    { legalArea: null },
  ])("omits a legal area that is not text: %j", ({ legalArea }) => {
    const decision = {
      ...OPEN_DECISION,
      court: "Synthetic court",
      courtAbbreviation: null,
      caseNumber: "SYN 1/2026",
      decisionDate: null,
      metadata: { legalArea },
    } satisfies Parameters<typeof decisionLawCrumbTrailOf>[0];

    expect(decisionLawCrumbTrailOf(decision).legalArea).toBeNull();
  });
});

test("every public law reader route has exactly one breadcrumb producer", () => {
  const lawRoutesDirectory = import.meta.dirname;
  const routeFiles = new Bun.Glob("**/*.tsx").scanSync({
    cwd: lawRoutesDirectory,
  });
  const readerRouteIds: string[] = [];

  for (const routeFile of routeFiles) {
    if (routeFile.split("/").some((segment) => segment.startsWith("-"))) {
      continue;
    }
    const source = readFileSync(new URL(routeFile, import.meta.url), "utf-8");
    if (
      !/\b(?:PublicStatuteViewer|PublicDecisionViewer|loadPublicDecisionRoute|loadPublicStatuteRoute)\b/u.test(
        source,
      )
    ) {
      continue;
    }
    const routeId = /createFileRoute\(\s*["']([^"']+)["']/u.exec(source)?.[1];
    expect(routeId).toBeDefined();
    if (routeId !== undefined) {
      readerRouteIds.push(routeId);
    }
  }

  expect(readerRouteIds.length).toBeGreaterThan(0);
  expect(readerRouteIds.toSorted()).toEqual(
    Object.keys(LAW_CRUMB_TRAIL_PRODUCERS).toSorted(),
  );
});
