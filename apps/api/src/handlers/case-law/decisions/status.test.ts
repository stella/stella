import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { loadCaseLawCorpusStatus } from "@/api/handlers/case-law/decisions/status";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";

/**
 * The number beside the search box is the corpus index's own count for the
 * scoped jurisdiction, so it says what a search can find and agrees with the
 * facets the same page renders. Nothing here counts rows.
 */

const COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("CZE is a public case-law country");
const UPDATED_AT = "2026-09-11T08:00:00+00:00";

const facetsOf = (
  country: LegalBrowseFacets["country"],
): LegalBrowseFacets => ({ country, court: [], year: [] });

const load = async (
  readFacets: (
    country: string,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>,
) => {
  const scopes: string[] = [];
  const result = await loadCaseLawCorpusStatus({
    country: COUNTRY,
    excludedSourceIds: [],
    readFacets: async ({ country }) => {
      scopes.push(country);
      return await readFacets(country);
    },
    readUpdatedAt: async () => UPDATED_AT,
  });
  return { result, scopes };
};

test("counts the bucket of the jurisdiction it was scoped to", async () => {
  const { result, scopes } = await load(async () =>
    Result.ok(
      facetsOf([
        { value: "SVK", count: 7 },
        { value: "CZE", count: 1_034_211 },
      ]),
    ),
  );

  expect(scopes).toEqual(["CZE"]);
  if (Result.isError(result)) {
    throw result.error;
  }
  // Buckets are count-ordered, so the jurisdiction's own bucket is wherever
  // its size puts it: reading the first one would report another country's.
  expect(result.value).toEqual({
    decisions: 1_034_211,
    updatedAt: UPDATED_AT,
  });
});

test("reports nothing for a jurisdiction the corpus has no bucket for", async () => {
  const { result } = await load(async () => Result.ok(facetsOf([])));

  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value).toEqual({ decisions: 0, updatedAt: UPDATED_AT });
});

test("a failed facets read fails the status instead of reporting zero", async () => {
  const { result } = await load(async () =>
    Result.err(new Error("corpus index unreachable")),
  );

  // Zero decisions is a fact about the corpus; the caller degrades to an
  // unknown status and logs, which it can only do if the failure reaches it.
  if (!Result.isError(result)) {
    throw new TypeError("expected the facets failure to reach the caller");
  }
  expect(result.error.message).toBe("corpus index unreachable");
});

test("a facets read that rejects fails the status as a value", async () => {
  // The load sits behind a cache that keeps whatever promise it is handed;
  // a rejection would be replayed to every caller for the whole window.
  const result = await loadCaseLawCorpusStatus({
    country: COUNTRY,
    excludedSourceIds: [],
    readFacets: async () => {
      throw new TypeError("provider crashed");
    },
    readUpdatedAt: async () => UPDATED_AT,
  });

  if (!Result.isError(result)) {
    throw new TypeError("expected the rejection to become an error value");
  }
  expect(result.error.message).toBe("provider crashed");
});
