import { expect, test } from "bun:test";

import {
  resolveUsCourt,
  US_COURTS,
  US_WRITABLE_COURT_IDS,
} from "@stll/api-contract/us-courts";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { usCourtRank } from "@/api/lib/case-law/court-ranks";
import {
  courtWeightFromMap,
  decisionCourtWeight,
} from "@/api/lib/case-law/court-weights";

const map = courtWeightMapFromSeed();

test("a directory court ranks by id exactly as its seeded row ranks it by name", () => {
  // Every court the seed names, SCOTUS included: the directory rank and the
  // registry row are two readings of one tier, and a decision stored with an
  // id must rank where the same decision ranked by name.
  const writable = US_COURTS.filter(({ id }) => US_WRITABLE_COURT_IDS.has(id));
  expect(writable.map(({ id }) => id)).toContain("scotus");
  for (const court of writable) {
    const byName = courtWeightFromMap(map, court.canonicalName, "USA");
    expect([
      court.id,
      decisionCourtWeight(map, {
        court: court.canonicalName,
        country: "USA",
        courtId: court.id,
      }),
    ]).toEqual([court.id, byName]);
  }
  expect(usCourtRank("scotus")).toEqual({
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  });
});

test("a directory court the seed does not name still ranks at its directory tier", () => {
  const circuit = resolveUsCourt("ca1");
  if (circuit.type !== "accepted" || US_WRITABLE_COURT_IDS.has("ca1")) {
    throw new Error("ca1 is not an accepted, unseeded court");
  }
  expect(circuit.court.tier).toBe("appellate");
  // By name it falls to the default rank; by id it holds its tier.
  expect(courtWeightFromMap(map, circuit.court.canonicalName, "USA")).toEqual({
    tier: 1,
    weight: 1,
  });
  expect(
    decisionCourtWeight(map, {
      court: circuit.court.canonicalName,
      country: "USA",
      courtId: "ca1",
    }),
  ).toEqual({ tier: 2, weight: 5 });
  expect(() =>
    decisionCourtWeight(map, {
      court: "Test court",
      country: "USA",
      courtId: "test",
    }),
  ).toThrow("Unranked directory court id: test");
});
