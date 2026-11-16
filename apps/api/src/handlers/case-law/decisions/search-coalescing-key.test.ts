import { describe, expect, test } from "bun:test";

import { caseLawSearchCoalescingKey } from "@/api/handlers/case-law/decisions/search";
import { legislationSearchCoalescingKey } from "@/api/handlers/legislation/search";
import { toSafeId } from "@/api/lib/branded-types";
import type { ServingCorpusIndexGeneration } from "@/api/lib/legal-search/corpus-index-generation-store";
import { withTenantActionSizePolicy } from "@/api/lib/rate-limit/action-size-limits";

const serving = (generation: string): ServingCorpusIndexGeneration => ({
  family: "case_law",
  generation,
  cluster: "q09",
});

const generation = serving("case_law_v8");

const body = (overrides: Record<string, unknown> = {}) => ({
  query: "výpověď z pracovního poměru",
  country: "CZE",
  limit: 10,
  facets: [],
  ...overrides,
});

// The key is a pure function of request and generation; identity reaching it
// would need a parameter, which the signature does not offer. These pin the
// rest: what the answer depends on enters, what it does not stays out.
describe("case-law search coalescing key", () => {
  test("the same request and generation map to one key", () => {
    expect(caseLawSearchCoalescingKey(body(), generation)).toBe(
      caseLawSearchCoalescingKey(body(), generation),
    );
    // Key order in the request never splits one search in two.
    expect(
      caseLawSearchCoalescingKey(
        { limit: 10, facets: [], country: "CZE", query: body().query },
        generation,
      ),
    ).toBe(caseLawSearchCoalescingKey(body(), generation));
  });

  test("the generation enters the key", () => {
    expect(caseLawSearchCoalescingKey(body(), serving("case_law_v9"))).not.toBe(
      caseLawSearchCoalescingKey(body(), generation),
    );
  });

  test("every filter that shapes the answer enters the key", () => {
    const base = caseLawSearchCoalescingKey(body(), generation);
    for (const filter of [
      { query: "jiný dotaz" },
      { country: "SVK" },
      { limit: 20 },
      { cursor: "abc" },
      { court: "Nejvyšší soud" },
      { language: "cs" },
      { dateFrom: "2020-01-01" },
      { sort: "newest" },
      { provision: "§ 52 ZP" },
      { sentenceAlignedExcerpt: true },
    ]) {
      expect(caseLawSearchCoalescingKey(body(filter), generation)).not.toBe(
        base,
      );
    }
  });

  test("the citing set is derived from the provision, so it stays out", () => {
    const withProvision = body({ provision: "§ 52 ZP" });
    expect(
      caseLawSearchCoalescingKey(
        { ...withProvision, provisionScope: { type: "broad" } },
        generation,
      ),
    ).toBe(caseLawSearchCoalescingKey(withProvision, generation));
    expect(
      caseLawSearchCoalescingKey(
        {
          ...withProvision,
          provisionDecisionIds: [toSafeId<"caseLawDecision">("decision-1")],
        },
        generation,
      ),
    ).toBe(caseLawSearchCoalescingKey(withProvision, generation));
  });

  test("a tenant's page limit enters as the value it resolves to", () => {
    const keyed = (pageSize: number) =>
      withTenantActionSizePolicy(
        {
          pageSize,
          requestBytes: 1,
          responseBytes: 1,
        },
        () => caseLawSearchCoalescingKey(body({ limit: 50 }), generation),
      );
    // Two tenants whose limits resolve the same share the answer...
    expect(keyed(50)).toBe(
      caseLawSearchCoalescingKey(body({ limit: 50 }), generation),
    );
    // ...and one whose limit truncates the page does not.
    expect(keyed(5)).not.toBe(
      caseLawSearchCoalescingKey(body({ limit: 50 }), generation),
    );
  });
});

describe("legislation search coalescing key", () => {
  const legislationServing: ServingCorpusIndexGeneration = {
    family: "legislation",
    generation: "legislation_v3",
    cluster: "q09",
  };
  const legislation = (overrides: Record<string, unknown> = {}) => ({
    query: "zákoník práce",
    jurisdiction: "CZE",
    ...overrides,
  });

  test("request and generation decide the key", () => {
    expect(
      legislationSearchCoalescingKey(legislation(), legislationServing),
    ).toBe(legislationSearchCoalescingKey(legislation(), legislationServing));
    expect(
      legislationSearchCoalescingKey(legislation(), {
        ...legislationServing,
        generation: "legislation_v4",
      }),
    ).not.toBe(
      legislationSearchCoalescingKey(legislation(), legislationServing),
    );
    expect(
      legislationSearchCoalescingKey(
        legislation({ query: "občanský zákoník" }),
        legislationServing,
      ),
    ).not.toBe(
      legislationSearchCoalescingKey(legislation(), legislationServing),
    );
  });
});
