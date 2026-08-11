import { describe, expect, test } from "bun:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";

/**
 * Allowed values of a CHECK constraint's IN list, read off the statement the
 * dialect renders. The list is built by interpolating the canonical const, so
 * each value arrives as its own SQL chunk; only the rendered text shows what
 * the database is asked to enforce.
 */
const extractCheckValues = (
  tableDef: Parameters<typeof getTableConfig>[0],
  constraintName: string,
): string[] => {
  const config = getTableConfig(tableDef);
  const check = config.checks.find((c) => c.name === constraintName);
  if (!check) {
    throw new Error(`CHECK constraint "${constraintName}" not found`);
  }

  const rendered = new PgDialect().sqlToQuery(check.value).sql;
  const inList = /IN\s*\((?<inList>[^)]+)\)/iu.exec(rendered)?.groups?.[
    "inList"
  ];
  if (inList === undefined) {
    throw new Error(`Could not parse IN list from "${constraintName}"`);
  }

  return inList.split(",").map((v) => v.trim().replace(/^'|'$/gu, ""));
};

describe("schema invariants", () => {
  const polarityValues = Object.values(POLARITY).toSorted();

  test("citations CHECK constraint matches POLARITY values", () => {
    const dbValues = extractCheckValues(
      caseLawCitations,
      "citations_polarity_values",
    ).toSorted();
    expect(dbValues).toEqual(polarityValues);
  });

  test("polarity_rules CHECK constraint matches POLARITY values", () => {
    const dbValues = extractCheckValues(
      caseLawPolarityRules,
      "polarity_rules_polarity_values",
    ).toSorted();
    expect(dbValues).toEqual(polarityValues);
  });

  test("corpus mirror CHECK constraint matches its domain type", () => {
    const dbValues = extractCheckValues(
      caseLawDecisions,
      "case_law_decisions_corpus_mirror_status_values",
    ).toSorted();
    expect(dbValues).toEqual(
      Object.values(CASE_LAW_CORPUS_MIRROR_STATUS).toSorted(),
    );
  });
});
