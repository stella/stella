import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

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

test("the directory rank SQL binds each ranked id once, grouped by value", () => {
  const dialect = new PgDialect();
  const weight = dialect.sqlToQuery(usCourtRankSql("d.court_id", "weight"));
  const tier = dialect.sqlToQuery(usCourtRankSql("d.court_id", "tier"));
  const bound = (params: readonly unknown[]): string[] =>
    params.flatMap((param) =>
      [...String(param).matchAll(/"([^"]+)"/gu)].map(([, id]) => id ?? ""),
    );

  // Every accepted court holds a weight above the unranked one, so every id
  // is bound; the tier binds only the courts above the lowest tier, since
  // the ELSE already answers the rest.
  expect(bound(weight.params).toSorted()).toEqual(
    US_COURTS.map(({ id }) => id).toSorted(),
  );
  expect(bound(tier.params).toSorted()).toEqual(
    US_COURTS.filter(
      ({ id }) => (usCourtRank(id)?.tier ?? 0) > UNRANKED_COURT_RANK.tier,
    )
      .map(({ id }) => id)
      .toSorted(),
  );
  // One parameter per rank value, and no id in the statement text: the text
  // is the same few hundred characters whatever the directory holds.
  expect(weight.params).toHaveLength(4);
  expect(tier.params).toHaveLength(2);
  for (const { sql: text } of [weight, tier]) {
    expect(text).not.toContain("scotus");
    expect(text.length).toBeLessThan(400);
  }
  expect(weight.sql).toEndWith(
    `ELSE ${String(UNRANKED_COURT_RANK.weight)} END`,
  );
  expect(tier.sql).toEndWith(`ELSE ${String(UNRANKED_COURT_RANK.tier)} END`);
});
