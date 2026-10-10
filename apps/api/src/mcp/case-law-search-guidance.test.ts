import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { apexCourtAbbreviations } from "@stll/api-contract/court-abbreviations";

import { envBaseServerSchema } from "@/api/env-base-schema";
import { CASE_LAW_SEARCH_GUIDANCE_MODES } from "@/api/lib/case-law/search-guidance-mode";
import { LIMITS } from "@/api/lib/limits";
import { searchCaseLawTexts } from "@/api/mcp/case-law-search-guidance";

describe("search_case_law guidance", () => {
  test("off keeps the search contract without experimental guidance", () => {
    expect(searchCaseLawTexts("off")).toEqual({
      description:
        "Search case law within one country. `queries` merges phrasings of one question; matchedQueries names those behind each hit. `limit` is the merged page, split evenly across them. Filters: court, language, dates, decision type, source_id (a `facets.source` bucket's `value`). Facets describe the first phrasing on page one, null later. Total is uncounted for multiple phrasings. Function words are not required terms; `searches[]` gives each phrasing's `queryUsed` and warnings, and `strict` requires every word. Hits carry citationAuthority (blended into ranking), matchingPassages, resourceName and caseNumber (a citable reference, not always a docket). read_case_law_decision types it; read_case_law_citations gives citing polarity.",
      queries: `Several phrasings of ONE question, at most ${String(LIMITS.caseLawSearchQueriesMax)}. Their pages are merged and deduplicated within the page, so a reformulation costs no extra round trip; one phrasing is a valid call.`,
      limit:
        "Merged-page size, split evenly across the queries (at least one hit each)",
      courts:
        'Match any listed court. For Czech apex courts use ["NS", "NSS", "ÚS"]. Combined with court, both filters must match.',
    });
  });

  test("v1 says how a phrasing is matched and how the limit is shared", () => {
    const { description, queries, limit } = searchCaseLawTexts("v1");

    expect(queries).toContain("must occur in the same passage");
    expect(queries).toContain("two to four words");
    expect(queries).toContain("a phrasing of its own");
    expect(queries).toContain("`§ N` plus the act's name or abbreviation");
    expect(limit).toContain("put the most central first");
    expect(description).toContain("most central phrasing first");
    expect(description).toContain("three are usually enough");
  });

  test("v1 names each admitted country's apex courts from the registry", () => {
    const { courts } = searchCaseLawTexts("v1");

    expect(courts).not.toContain("Czech");
    for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
      const abbreviations = apexCourtAbbreviations(country);
      // An admitted country the registry has no apex courts for would leave
      // the example silent about it; admitting one is the moment to add them.
      expect(abbreviations.length).toBeGreaterThan(0);
      expect(courts).toContain(
        `${country} [${abbreviations.map((abbreviation) => `"${abbreviation}"`).join(", ")}]`,
      );
    }
  });

  test("the gate defaults off and rejects an unknown mode", () => {
    const schema = envBaseServerSchema.MCP_CASE_LAW_SEARCH_GUIDANCE;
    expect(v.parse(schema, undefined)).toBe("off");
    for (const mode of CASE_LAW_SEARCH_GUIDANCE_MODES) {
      expect(v.parse(schema, mode)).toBe(mode);
    }
    expect(v.safeParse(schema, "on").success).toBe(false);
  });
});
