import { describe, expect, test } from "bun:test";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { caseLawPolarityRules } from "@/api/db/schema";
import {
  POLARITIES,
  POLARITY_PRECEDENCE,
} from "@/api/handlers/case-law/polarity/consts";
import { polarityRuleOrder } from "@/api/handlers/case-law/polarity/rule-engine";

/**
 * The rule query's ORDER BY is assembled from a const map rather than written
 * out, so a mistake in the assembly produces SQL no type can reject. It runs
 * in a background classifier, where a malformed clause would surface as rules
 * quietly failing to load rather than as a failing request. Rendering the
 * query through drizzle's dialect gives the exact string the driver would
 * send, without standing up a database.
 */
const rendered = new QueryBuilder()
  .select()
  .from(caseLawPolarityRules)
  .orderBy(...polarityRuleOrder)
  .toSQL();

/** Only the clause under test; the select list names every column. */
const orderBy = rendered.sql.slice(rendered.sql.indexOf("order by"));

describe("the polarity rule query orders by precedence", () => {
  test("orders by severity, then pattern length, then id", () => {
    expect(orderBy).toStartWith("order by CASE WHEN ");
    expect(orderBy).toContain(
      'END, length("case_law_polarity_rules"."pattern") desc, "case_law_polarity_rules"."id"',
    );
  });

  test("scores every polarity, and none by match count", () => {
    // Each arm binds the polarity as a parameter, so the names live in
    // `params` while the scores are inlined into the CASE.
    for (const polarity of POLARITIES) {
      expect(rendered.params).toContain(polarity);
      expect(orderBy).toContain(
        `THEN ${String(POLARITY_PRECEDENCE[polarity])}`,
      );
    }

    expect(orderBy).not.toContain("match_count");
  });

  test("negative outscores every other polarity", () => {
    // The property the ORDER BY exists for: severity decides, and `negative`
    // is the most severe, so it must sort ahead of everything else.
    const negative = POLARITY_PRECEDENCE.negative;

    for (const polarity of POLARITIES) {
      if (polarity === "negative") {
        continue;
      }
      expect(POLARITY_PRECEDENCE[polarity]).toBeGreaterThan(negative);
    }
  });
});
