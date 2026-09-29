import { expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { resolveUsCourt } from "@stll/api-contract/us-courts";

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
import { logger } from "@/api/lib/observability/logger";

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
  ).toEqual({ type: "ranked", tier: 2, weight: 5 });
  expect(
    citingCourtWeight(map, { court: SCOTUS, country: "USA", courtId: "ca1" }),
  ).toBe(5);
  expect(usCourtRank("scotus")).toEqual({
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  });
});

test("a directory decision without an accepted court id is unranked and reported, never ranked by name", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const malformed = [null, "test", "Scotus", "unknown-court"];
    for (const courtId of malformed) {
      // By name the registry would rank this court supreme.
      const decision = { court: SCOTUS, country: "USA", courtId };
      expect(decisionCourtWeight(map, decision)).toEqual({
        type: "invalid-directory-identity",
        ...UNRANKED_COURT_RANK,
      });
      expect(citingCourtWeight(map, decision)).toBe(UNRANKED_COURT_RANK.weight);
    }
    expect(courtTierLabelFromMap(map, "Supreme Court of Nowhere", "USA")).toBe(
      "other",
    );
    expect(
      warn.mock.calls.map(([message, fields]) => [message, fields]),
    ).toEqual([
      ...malformed.flatMap((courtId) =>
        Array.from({ length: 2 }, () => [
          "case_law.court_rank.invalid_directory_identity",
          {
            country: "USA",
            lookup: "court_id",
            "court.identity": courtId ?? "none",
            effect: "unranked",
          },
        ]),
      ),
      [
        "case_law.court_rank.invalid_directory_identity",
        {
          country: "USA",
          lookup: "court_name",
          "court.identity": "Supreme Court of Nowhere",
          effect: "unranked",
        },
      ],
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("the directory rank SQL uses a keyed lookup without directory-size parameters", () => {
  const dialect = new PgDialect();
  const weight = dialect.sqlToQuery(usCourtRankSql("d.court_id", "weight"));
  const tier = dialect.sqlToQuery(usCourtRankSql("d.court_id", "tier"));
  for (const [field, rendered] of [
    ["weight", weight],
    ["tier", tier],
  ] as const) {
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("case_law_court_directory_ranks");
    expect(rendered.sql).toContain("r.country = 'USA'");
    expect(rendered.sql).toContain("r.court_id = d.court_id");
    expect(rendered.sql).toContain(`r.${field}`);
    expect(rendered.sql).not.toContain("scotus");
    expect(rendered.sql.length).toBeLessThan(400);
  }
  expect(weight.sql).toEndWith(`, ${UNRANKED_COURT_RANK.weight})`);
  expect(tier.sql).toEndWith(`, ${UNRANKED_COURT_RANK.tier})`);
});
