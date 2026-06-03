import { describe, expect, test } from "bun:test";

import {
  createPublicLegalMaterialPath,
  createPublicLegalMaterialRouteParams,
  normalizePublicLegalMaterialLanguageSegment,
  shouldUsePublicLegalMaterialLanguageSegment,
} from "@/lib/public-law-material-route";

describe("public legal material routes", () => {
  test("creates versioned guideline URLs without fake language variants", () => {
    const params = createPublicLegalMaterialRouteParams({
      authority: "WP29",
      language: "en",
      languageAlternates: [],
      materialType: "guidelines",
      slug: "Guidelines on Data Protection Impact Assessment",
      version: "WP 248 rev.01",
    });

    expect(params).toEqual({
      authority: "wp29",
      materialType: "guidelines",
      slug: "guidelines-on-data-protection-impact-assessment",
      version: "wp-248-rev-01",
    });
    expect(createPublicLegalMaterialPath(params)).toBe(
      "/law/guidelines/wp29/guidelines-on-data-protection-impact-assessment/v/wp-248-rev-01",
    );
  });

  test("creates language URLs for official translations of the same material version", () => {
    const params = createPublicLegalMaterialRouteParams({
      authority: "WP29",
      language: "EN",
      languageAlternates: [{ language: "en" }, { language: "fr" }],
      materialType: "guidelines",
      slug: "Guidelines on Data Protection Impact Assessment",
      version: "v1.0",
    });

    expect(params).toEqual({
      authority: "wp29",
      language: "en",
      materialType: "guidelines",
      slug: "guidelines-on-data-protection-impact-assessment",
      version: "v1-0",
    });
    expect(createPublicLegalMaterialPath(params)).toBe(
      "/law/guidelines/wp29/guidelines-on-data-protection-impact-assessment/v/v1-0/lang/en",
    );
  });

  test("supports unversioned overview URLs separately from versioned text URLs", () => {
    const params = createPublicLegalMaterialRouteParams({
      authority: "EDPB",
      materialType: "guidelines",
      slug: "Guidelines 05/2020 on consent",
    });

    expect(createPublicLegalMaterialPath(params)).toBe(
      "/law/guidelines/edpb/guidelines-05-2020-on-consent",
    );
  });

  test("normalizes material language segments conservatively", () => {
    expect(normalizePublicLegalMaterialLanguageSegment("PT_BR")).toBe("pt-br");
    expect(normalizePublicLegalMaterialLanguageSegment("english")).toBe(null);
    expect(
      shouldUsePublicLegalMaterialLanguageSegment({
        language: "en",
        languageAlternateCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldUsePublicLegalMaterialLanguageSegment({
        language: "en",
        languageAlternateCount: 2,
      }),
    ).toBe(true);
  });

  test("does not create material language URLs from duplicate or invalid alternates", () => {
    expect(
      shouldUsePublicLegalMaterialLanguageSegment({
        language: "fr",
        languageAlternates: [
          { language: "not a language" },
          { language: "FR" },
          { language: "fr" },
        ],
      }),
    ).toBe(false);

    expect(
      createPublicLegalMaterialRouteParams({
        authority: "WP29",
        language: "FR",
        languageAlternates: [
          { language: "not a language" },
          { language: "FR" },
          { language: "fr" },
        ],
        materialType: "guidelines",
        slug: "Guidelines on DPIA",
        version: "WP 248 rev.01",
      }),
    ).toEqual({
      authority: "wp29",
      materialType: "guidelines",
      slug: "guidelines-on-dpia",
      version: "wp-248-rev-01",
    });
  });

  test("uses explicit material language alternate counts from public APIs", () => {
    expect(
      createPublicLegalMaterialRouteParams({
        authority: "EDPB",
        language: "EN",
        languageAlternateCount: 2,
        materialType: "guidelines",
        slug: "Guidelines 05/2020 on consent",
      }),
    ).toEqual({
      authority: "edpb",
      language: "en",
      materialType: "guidelines",
      slug: "guidelines-05-2020-on-consent",
    });
  });
});
