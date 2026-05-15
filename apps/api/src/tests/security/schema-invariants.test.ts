import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
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
      const match = /IN\s*\(([^)]+)\)/i.exec(str);
      if (match?.[1]) {
        inList = match[1];
        break;
      }
    }
  }

  if (!inList) {
    throw new Error(`Could not parse IN list from "${constraintName}"`);
  }

  return inList.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
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
});
