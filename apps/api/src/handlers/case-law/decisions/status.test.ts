import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DAY_IN_MS } from "@stll/time";

import { COVERAGE_CURRENT_WITHIN_MS } from "@/api/handlers/case-law/decisions/coverage-health";
import {
  caseLawCorpusStatusAt,
  loadCaseLawCorpusSnapshot,
} from "@/api/handlers/case-law/decisions/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { BoundedReadResult } from "@/api/lib/db/read-bounded";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";

/**
 * The number beside the search box is the corpus index's own count for the
 * scoped jurisdiction, so it says what a search can find and agrees with the
 * facets the same page renders. Nothing here counts rows.
 */

const COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("CZE is a public case-law country");
const UPDATED_AT = "2026-09-11T08:00:00+00:00";
const NOW = new Date("2026-09-12T08:00:00Z");

const facetsOf = (
  country: LegalBrowseFacets["country"],
): LegalBrowseFacets => ({ country, court: [], year: [] });

type SourceRow = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
  enabled: boolean;
  lastSyncAt: Date | null;
};

const sourceOf = (
  adapterKey: string,
  syncedDaysAgo: number,
  enabled = true,
): SourceRow => ({
  id: createSafeId<"caseLawSource">(),
  adapterKey,
  enabled,
  lastSyncAt: new Date(NOW.getTime() - syncedDaysAgo * DAY_IN_MS),
});

const CURRENT_CZ_SOURCE = sourceOf(ADAPTER_KEYS.CZ_NS, 0);

const complete = (rows: SourceRow[]): BoundedReadResult<SourceRow> => ({
  type: "complete",
  rows,
});

const loadWith = async ({
  excludedSourceIds = [],
  readFacets = async () => Result.ok(facetsOf([{ value: "CZE", count: 12 }])),
  readSources = async () => complete([CURRENT_CZ_SOURCE]),
}: {
  excludedSourceIds?: SourceRow["id"][];
  readFacets?: (
    country: string,
  ) => Promise<Result<LegalBrowseFacets, { message: string }>>;
  readSources?: () => Promise<BoundedReadResult<SourceRow>>;
}) => {
  const scopes: string[] = [];
  const snapshot = await loadCaseLawCorpusSnapshot({
    country: COUNTRY,
    excludedSourceIds,
    readFacets: async ({ country }) => {
      scopes.push(country);
      return await readFacets(country);
    },
    readUpdatedAt: async () => UPDATED_AT,
    readSources,
  });
  const result = Result.isError(snapshot)
    ? snapshot
    : Result.ok(caseLawCorpusStatusAt(snapshot.value, NOW));
  return { result, scopes, snapshot };
};

const healthOf = async (sources: SourceRow[]) => {
  const { result } = await loadWith({
    readSources: async () => complete(sources),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.health;
};

test("counts the bucket of the jurisdiction it was scoped to", async () => {
  const { result, scopes } = await loadWith({
    readFacets: async () =>
      Result.ok(
        facetsOf([
          { value: "SVK", count: 7 },
          { value: "CZE", count: 1_034_211 },
        ]),
      ),
  });

  expect(scopes).toEqual(["CZE"]);
  if (Result.isError(result)) {
    throw result.error;
  }
  // Buckets are count-ordered, so the jurisdiction's own bucket is wherever
  // its size puts it: reading the first one would report another country's.
  expect(result.value).toEqual({
    decisions: 1_034_211,
    updatedAt: UPDATED_AT,
    health: "current",
  });
});

test("reports nothing for a jurisdiction the corpus has no bucket for", async () => {
  const { result } = await loadWith({
    readFacets: async () => Result.ok(facetsOf([])),
  });

  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value.decisions).toBe(0);
});

test("a failed facets read fails the status instead of reporting zero", async () => {
  const { result } = await loadWith({
    readFacets: async () => Result.err(new Error("corpus index unreachable")),
  });

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
  const { result } = await loadWith({
    readFacets: async () => {
      throw new TypeError("provider crashed");
    },
  });

  if (!Result.isError(result)) {
    throw new TypeError("expected the rejection to become an error value");
  }
  expect(result.error.message).toBe("provider crashed");
});

test("a failed source read fails the status instead of claiming a source never ran", async () => {
  const { result } = await loadWith({
    readSources: async () => {
      throw new TypeError("reader pool exhausted");
    },
  });

  if (!Result.isError(result)) {
    throw new TypeError("expected the source failure to reach the caller");
  }
  expect(result.error.message).toBe("reader pool exhausted");
});

test("a source registry past the read bound fails the status instead of judging part of it", async () => {
  const { result } = await loadWith({
    readSources: async () => ({ type: "overflow", cap: 1 }),
  });

  // The rows left out could hold the one stalled court.
  if (!Result.isError(result)) {
    throw new TypeError("expected the overflow to reach the caller");
  }
  expect(result.error.message).toContain("read bound of 1 rows");
});

test("one stalled court makes the country stalled, as on the coverage page", async () => {
  expect(
    await healthOf([CURRENT_CZ_SOURCE, sourceOf(ADAPTER_KEYS.CZ_REGIONAL, 9)]),
  ).toBe("stalled");
  expect(
    await healthOf([CURRENT_CZ_SOURCE, sourceOf(ADAPTER_KEYS.CZ_REGIONAL, 3)]),
  ).toBe("delayed");
});

test("judges the country only by its own sources", async () => {
  // A stalled Slovak feed says nothing about the Czech corpus.
  expect(
    await healthOf([CURRENT_CZ_SOURCE, sourceOf(ADAPTER_KEYS.SK_COURTS, 30)]),
  ).toBe("current");
  // A switched-off source is a decision, not a fault, and is not judged.
  expect(
    await healthOf([
      CURRENT_CZ_SOURCE,
      sourceOf(ADAPTER_KEYS.CZ_REGIONAL, 30, false),
    ]),
  ).toBe("current");
  expect(await healthOf([sourceOf(ADAPTER_KEYS.SK_COURTS, 0)])).toBe("unknown");
});

test("a withheld source does not count towards the health", async () => {
  const withheld = sourceOf(ADAPTER_KEYS.CZ_REGIONAL, 30);
  const { result } = await loadWith({
    excludedSourceIds: [withheld.id],
    readSources: async () => complete([CURRENT_CZ_SOURCE, withheld]),
  });

  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value.health).toBe("current");
});

test("a cached snapshot is judged at the instant it is served", async () => {
  // Synced a minute inside the current window when the snapshot was read.
  const { snapshot } = await loadWith({
    readSources: async () =>
      complete([
        {
          ...CURRENT_CZ_SOURCE,
          lastSyncAt: new Date(
            NOW.getTime() - COVERAGE_CURRENT_WITHIN_MS + 60_000,
          ),
        },
      ]),
  });
  if (Result.isError(snapshot)) {
    throw snapshot.error;
  }

  // The coverage page measures from its own request; a snapshot served two
  // minutes later must not keep the verdict its window has since passed.
  expect(caseLawCorpusStatusAt(snapshot.value, NOW).health).toBe("current");
  expect(
    caseLawCorpusStatusAt(snapshot.value, new Date(NOW.getTime() + 120_000))
      .health,
  ).toBe("delayed");
});
