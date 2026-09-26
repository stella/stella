import { expect, test } from "bun:test";

import { resolveUsCourt, US_COURTS } from "@stll/api-contract/us-courts";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  UNRANKED_COURT_RANK,
  usCourtRank,
  usCourtRankSql,
} from "@/api/lib/case-law/court-ranks";
import {
  citingCourtWeight,
  courtTierLabelFromMap,
  courtWeightFromMap,
  decisionCourtWeight,
} from "@/api/lib/case-law/court-weights";

const map = courtWeightMapFromSeed();

const SCOTUS = "Supreme Court of the United States";

test("a directory decision ranks by its court id, whatever its name says", () => {
  const circuit = resolveUsCourt("ca1");
  if (circuit.type !== "accepted") {
    throw new Error("ca1 is not an accepted court");
  }
  expect(circuit.court.tier).toBe("appellate");
  // The registry keeps a name row for the Supreme Court; an id that names
  // the First Circuit still ranks as the First Circuit.
  expect(courtWeightFromMap(map, SCOTUS, "USA")).toEqual({
    tier: 3,
    weight: 8,
  });
  expect(
    decisionCourtWeight(map, { court: SCOTUS, country: "USA", courtId: "ca1" }),
  ).toEqual({ tier: 2, weight: 5 });
  expect(
    citingCourtWeight(map, { court: SCOTUS, country: "USA", courtId: "ca1" }),
  ).toBe(5);
  expect(usCourtRank("scotus")).toEqual({
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  });
});

test("a directory decision without an accepted court id fails rather than ranking by name", () => {
  for (const courtId of [null, "test", "Scotus", "unknown-court"]) {
    expect(() =>
      decisionCourtWeight(map, { court: SCOTUS, country: "USA", courtId }),
    ).toThrow(`Unranked directory court id: ${courtId ?? "none"}`);
    expect(() =>
      citingCourtWeight(map, { court: SCOTUS, country: "USA", courtId }),
    ).toThrow(`Unranked directory court id: ${courtId ?? "none"}`);
  }
  expect(() =>
    courtTierLabelFromMap(map, "Supreme Court of Nowhere", "USA"),
  ).toThrow("Court name is not in the USA court directory");
});

test("the directory rank SQL lists each ranked id once, grouped by value", () => {
  const listed = (rendered: string): string[] =>
    [...rendered.matchAll(/"([^"]+)"/gu)].map(([, id]) => id ?? "");
  const weight = usCourtRankSql("d.court_id", "weight");
  const tier = usCourtRankSql("d.court_id", "tier");

  // Every accepted court holds a weight above the unranked one, so every id
  // is listed; the tier lists only the courts above the lowest tier, since
  // the ELSE already answers the rest.
  expect(listed(weight).toSorted()).toEqual(
    US_COURTS.map(({ id }) => id).toSorted(),
  );
  expect(listed(tier).toSorted()).toEqual(
    US_COURTS.filter(
      ({ id }) => (usCourtRank(id)?.tier ?? 0) > UNRANKED_COURT_RANK.tier,
    )
      .map(({ id }) => id)
      .toSorted(),
  );
  expect(weight.match(/\bWHEN\b/gu)).toHaveLength(4);
  expect(tier.match(/\bWHEN\b/gu)).toHaveLength(2);
  expect(weight).toEndWith(`ELSE ${String(UNRANKED_COURT_RANK.weight)} END`);
  expect(tier).toEndWith(`ELSE ${String(UNRANKED_COURT_RANK.tier)} END`);
});
