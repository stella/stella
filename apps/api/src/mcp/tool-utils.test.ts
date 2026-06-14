import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  buildCaseLawDecisionAppUrl,
  buildCaseLawDecisionUrl,
  slugifyCaseLawPathSegment,
} from "@/api/mcp/tool-utils";

// FRONTEND_URL is "http://localhost:3000" (no trailing slash) from
// the test env preload; getAppBaseUrl() strips any trailing slash.
const BASE = "http://localhost:3000";

describe("slugifyCaseLawPathSegment", () => {
  test("lowercases, strips diacritics, and collapses runs to single hyphens", () => {
    expect(slugifyCaseLawPathSegment("Nejvyšší soud")).toBe("nejvyssi-soud");
  });

  test("collapses non-alphanumerics and trims leading/trailing hyphens", () => {
    expect(slugifyCaseLawPathSegment("  29 Cdo 123/2024  ")).toBe(
      "29-cdo-123-2024",
    );
  });

  test("falls back to 'unknown' when nothing alphanumeric remains", () => {
    expect(slugifyCaseLawPathSegment("///")).toBe("unknown");
    expect(slugifyCaseLawPathSegment("")).toBe("unknown");
  });
});

describe("buildCaseLawDecisionUrl", () => {
  test("uses a stored slug verbatim (re-slugified) over the case number", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "29 Cdo 123/2024",
        country: "CZE",
        court: "Nejvyšší soud",
        slug: "official-stable-slug",
      }),
    ).toBe(`${BASE}/law/cze/cases/nejvyssi-soud/official-stable-slug`);
  });

  test("derives the decision slug from the case number when no stored slug", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "29 Cdo 123/2024",
        country: "CZE",
        court: "Nejvyšší soud",
      }),
    ).toBe(`${BASE}/law/cze/cases/nejvyssi-soud/29-cdo-123-2024`);
  });

  test("lowercases the country and slugifies the court segment", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "C-123/24",
        country: "DEU",
        court: "Bundesgerichtshof",
        slug: "x",
      }),
    ).toBe(`${BASE}/law/deu/cases/bundesgerichtshof/x`);
  });

  test("uses the unknown-court segment for a blank court", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "   ",
        slug: "s",
      }),
    ).toBe(`${BASE}/law/cze/cases/unknown-court/s`);
  });

  test("inserts the language segment only when more than one language alternate exists", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 2,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/cs/s`);
  });

  test("omits the language segment when only one alternate exists", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 1,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("omits the language segment when the language code is not a valid BCP-47-ish tag", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "not a language",
        languageAlternateCount: 5,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("normalizes underscores in the language tag to hyphens", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "CS_CZ",
        languageAlternateCount: 2,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/cs-cz/s`);
  });

  test("counts distinct normalized language alternates when no explicit count is given", () => {
    const url = buildCaseLawDecisionUrl({
      caseNumber: "1/24",
      country: "CZE",
      court: "NS",
      slug: "s",
      language: "cs",
      languageAlternates: [
        { language: "cs" },
        { language: "CS" }, // dedupes with "cs" after normalization
        { language: "en" },
        { language: "??" }, // invalid -> ignored
        "not-an-object", // malformed -> ignored
      ],
    });

    // Two distinct valid languages (cs, en) > 1 -> language segment present.
    expect(url).toBe(`${BASE}/law/cze/cases/ns/cs/s`);
  });

  test("omits the language segment when distinct alternates do not exceed one", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternates: [{ language: "cs" }, { language: "CS" }],
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("prefers the explicit alternate count over the alternates array", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 1,
        languageAlternates: [{ language: "cs" }, { language: "en" }],
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });
});

describe("buildCaseLawDecisionAppUrl gate", () => {
  let previousIsDev: boolean;
  let previousFeaturePublicLaw: boolean;

  const input = {
    caseNumber: "1/24",
    country: "CZE",
    court: "NS",
    slug: "s",
  };

  beforeEach(() => {
    previousIsDev = env.isDev;
    previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
  });

  afterEach(() => {
    env.isDev = previousIsDev;
    env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
  });

  test("returns null when public law is disabled and not in dev", () => {
    env.isDev = false;
    env.FEATURE_PUBLIC_LAW = false;

    expect(buildCaseLawDecisionAppUrl(input)).toBeNull();
  });

  test("builds the URL when the public-law feature flag is on", () => {
    env.isDev = false;
    env.FEATURE_PUBLIC_LAW = true;

    expect(buildCaseLawDecisionAppUrl(input)).toBe(
      `${BASE}/law/cze/cases/ns/s`,
    );
  });

  test("builds the URL in dev regardless of the feature flag", () => {
    env.isDev = true;
    env.FEATURE_PUBLIC_LAW = false;

    expect(buildCaseLawDecisionAppUrl(input)).toBe(
      `${BASE}/law/cze/cases/ns/s`,
    );
  });
});
