import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";

/**
 * Extract allowed values from a CHECK constraint's IN list.
 * Drizzle stores the SQL as chunks: column ref + raw string
 * containing ` IN ('a','b','c')`.
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

  // Walk SQL chunks to find the IN list string
  const chunks = check.value.getSQL().queryChunks;
  let inList: string | undefined;
  for (const chunk of chunks) {
    if (
      typeof chunk === "object" &&
      "value" in chunk &&
      Array.isArray(chunk.value)
    ) {
      const str = String(chunk.value[0] ?? "");
      const match = /IN\s*\((?<inList>[^)]+)\)/iu.exec(str);
      if (match?.groups?.["inList"]) {
        inList = match.groups["inList"];
        break;
      }
    }
  }

  if (!inList) {
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
