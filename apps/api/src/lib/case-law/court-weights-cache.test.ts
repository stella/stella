import { panic } from "better-result";
import { beforeEach, expect, test } from "bun:test";

import {
  courtTierSqlFromMap,
  courtWeightFromMap,
  createCourtWeightCache,
} from "@/api/lib/case-law/court-weights";
import type {
  CourtWeightCache,
  CourtWeightMap,
} from "@/api/lib/case-law/court-weights";

/**
 * The registry is cached for a minute, and a request that times its Postgres
 * work has to charge itself for the query it made, not for the call it made.
 * `onRead` is the seam that tells those apart: it runs on a miss and never on
 * a hit, so counting it counts reads.
 */

const ROWS = [
  {
    country: "CZE",
    courtPattern: "nejvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
];

let reads: number;
let cache: CourtWeightCache;

/** Stands in for the production read; never calls the one it is handed. */
const countedRead = async () => {
  reads += 1;
  return ROWS;
};

beforeEach(() => {
  // Every read below goes through a hook that supplies its own rows, so the
  // source itself is never reached.
  cache = createCourtWeightCache(async () =>
    panic("the court-weight source is not read by these tests"),
  );
  reads = 0;
});

test("two requests inside the TTL read once, not once each", async () => {
  const first = await cache.load({ onRead: countedRead });
  const second = await cache.load({ onRead: countedRead });

  expect(reads).toBe(1);
  // And both requests rank against the same registry.
  expect(second).toBe(first);
  expect(second.get("CZE")).toHaveLength(1);
});

test("the read runs again once the cache is dropped", async () => {
  await cache.load({ onRead: countedRead });
  cache.invalidate();
  await cache.load({ onRead: countedRead });

  expect(reads).toBe(2);
});

test("a hit serves a caller that passes no hook at all", async () => {
  await cache.load({ onRead: countedRead });
  // No hook, and no read either: the cache answers, which is why an untimed
  // caller never reaches the production query here.
  const map = await cache.load();

  expect(reads).toBe(1);
  expect(map.get("CZE")).toHaveLength(1);
});

/**
 * Two jurisdictions ranking the same court name at the same tier: the pair
 * the precedence order has to decide, and the pair a row order used to.
 */
const OVERLAPPING_ROWS = [
  {
    country: "XAA",
    courtPattern: "shared court",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "XBB",
    courtPattern: "shared court",
    tier: 3,
    tierLabel: "supreme",
    weight: 5,
  },
];

test("a cache reload ranks an overlapping court the same, whatever order the rows arrive in", async () => {
  const registryFrom = async (rows: typeof OVERLAPPING_ROWS) => {
    cache.invalidate();
    return await cache.load({ onRead: async () => rows });
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
