import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

/**
 * The plan text of an `EXPLAIN`, whatever shape the driver wraps its rows in.
 * Plan guards assert against these lines, so a driver returning something
 * unreadable must fail the test rather than an empty plan passing it.
 */
export const planLines = (explained: unknown): string[] => {
  const rows = isRecord(explained) ? explained["rows"] : explained;
  if (!Array.isArray(rows)) {
    return panic("EXPLAIN did not return plan rows");
  }
  return rows.map((row: unknown) => {
    const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof text === "string"
      ? text
      : panic("EXPLAIN row has no plan text");
  });
};
