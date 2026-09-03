import { beforeEach, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  courtTierSqlFromMap,
  courtWeightFromMap,
  invalidateCourtWeightsCache,
  loadCourtWeights,
} from "@/api/lib/case-law/court-weights";
import type { CourtWeightMap } from "@/api/lib/case-law/court-weights";

/**
 * The registry is cached for a minute, and a request that times its Postgres
 * work has to charge itself for the query it made, not for the call it made.
 * `onRead` is the seam that tells those apart: it runs on a miss and never on
 * a hit, so counting it counts reads.
 */

const ROWS = [
  {
    id: createSafeId<"caseLawCourtWeight">(),
    country: "CZE",
    courtPattern: "nejvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

let reads: number;

/** Stands in for the production read; never calls the one it is handed. */
const countedRead = async () => {
  reads += 1;
  return ROWS;
};

beforeEach(() => {
  invalidateCourtWeightsCache();
  reads = 0;
});

test("two requests inside the TTL read once, not once each", async () => {
  const first = await loadCourtWeights({ onRead: countedRead });
  const second = await loadCourtWeights({ onRead: countedRead });

  expect(reads).toBe(1);
  // And both requests rank against the same registry.
  expect(second).toBe(first);
  expect(second.get("CZE")).toHaveLength(1);
});

test("the read runs again once the cache is dropped", async () => {
  await loadCourtWeights({ onRead: countedRead });
  invalidateCourtWeightsCache();
  await loadCourtWeights({ onRead: countedRead });

  expect(reads).toBe(2);
});

test("a hit serves a caller that passes no hook at all", async () => {
  await loadCourtWeights({ onRead: countedRead });
  // No hook, and no read either: the cache answers, which is why an untimed
  // caller never reaches the production query here.
  const map = await loadCourtWeights();

  expect(reads).toBe(1);
  expect(map.get("CZE")).toHaveLength(1);
});

/**
 * Two jurisdictions ranking the same court name at the same tier: the pair
 * the precedence order has to decide, and the pair a row order used to.
 */
const OVERLAPPING_ROWS = [
  {
    id: createSafeId<"caseLawCourtWeight">(),
    country: "XAA",
    courtPattern: "shared court",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: createSafeId<"caseLawCourtWeight">(),
    country: "XBB",
    courtPattern: "shared court",
    tier: 3,
    tierLabel: "supreme",
    weight: 5,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

test("a cache reload ranks an overlapping court the same, whatever order the rows arrive in", async () => {
  const registryFrom = async (rows: typeof OVERLAPPING_ROWS) => {
    invalidateCourtWeightsCache();
    return await loadCourtWeights({ onRead: async () => rows });
  };
  const rank = (map: CourtWeightMap) => ({
    lookup: courtWeightFromMap(map, "Shared Court"),
    rendered: courtTierSqlFromMap({
      countryColumn: "d.country",
      courtColumn: "d.court",
      map,
    }),
  });

  const asRead = rank(await registryFrom(OVERLAPPING_ROWS));
  const reversed = rank(await registryFrom(OVERLAPPING_ROWS.toReversed()));

  // The row order decides nothing: the tier, the weight the citation graph
  // reads, and the SQL the Postgres paths rank by are one registry either way.
  expect(reversed).toEqual(asRead);
  // And the jurisdiction that wins the tie is the lower country code, not
  // whichever row the heap happened to return first.
  expect(asRead.lookup).toEqual({ weight: 8, tier: 3 });
});
