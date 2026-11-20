import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { apexCourtAbbreviations } from "@stll/api-contract/case-law-court-abbreviations";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { envBaseServerSchema } from "@/api/env-base-schema";
import { CASE_LAW_SEARCH_GUIDANCE_MODES } from "@/api/lib/case-law/search-guidance-mode";
import { LIMITS } from "@/api/lib/limits";
import { searchCaseLawTexts } from "@/api/mcp/case-law-search-guidance";

describe("search_case_law guidance", () => {
  test("off keeps the search contract without experimental guidance", () => {
    expect(searchCaseLawTexts("off")).toEqual({
      description:
        "Search case law. `queries` merges phrasings; matchedQueries names each hit's phrasings. `limit` is split evenly. Facets are opt-in, first phrasing, page one. total needs facets and one phrasing; not_counted means unknown, never zero. strict needs every word, not necessarily adjacent (quote a phrase for that); otherwise function words are optional and some_terms hits may appear; terms names each hit's words. searches[] has queryUsed/warnings; on time_budget or partial_matches_budget nextCursor reruns it. source_id uses facets.source values." +
        ' Under load it may answer status "running": not a failure. After retryAfterMs, repeat the call with continuation_token; "partial" is never the full answer.',
      queries: `Several phrasings of ONE question, at most ${String(LIMITS.caseLawSearchQueriesMax)}. Their pages are merged and deduplicated within the page, so a reformulation costs no extra round trip; one phrasing is a valid call. Omit queries and pass provision to list every decision citing it, by authority or date, paged without a total.`,
      limit:
        "Merged-page size, split evenly across the queries (at least one hit each)",
      courts:
        'Match any listed court. For Czech apex courts use ["NS", "NSS", "ÚS"]. Combined with court, both filters must match.',
    });
  });

  test("v1 says how a phrasing is matched and how the limit is shared", () => {
    const { description, queries, limit } = searchCaseLawTexts("v1");

    // True of every serving generation: neither says where in a decision the
    // words must sit, only that a full match holds them all.
    expect(queries).toContain(
      "A full match needs every word of a phrasing except function words, so each extra word narrows the full matches",
    );
    expect(queries).not.toContain("one passage");
    // Partial matches can be on a page, so v1 never says every hit holds
    // every word, nor where on the page they sit.
    expect(description).toContain("some_terms hits may appear");
    expect(description).toContain("not necessarily adjacent");
    expect(description).not.toContain("append");
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
