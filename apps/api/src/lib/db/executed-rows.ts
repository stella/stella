import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

/**
 * Rows from `execute` under either driver shape.
 *
 * The server driver yields the rows directly; pglite, which the database tests
 * run on, wraps them in `{ rows }`. A reader that assumes one shape works in
 * exactly one of the two places, so a query verified by a test can still return
 * nothing in production, and the reverse. Every caller of `execute` that reads
 * rows back goes through here so neither half can be forgotten.
 *
 * A third shape is not an empty result, it is a driver this function has never
 * seen. Answering `[]` would hand every caller the reading that looks like
 * success — no rows found — which for a guard means the guard passes. That is
 * the wrong direction to fail in, so an unrecognised shape panics with what it
 * received instead.
 */
export const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return panic(
    `Unsupported execute() result shape: ${typeof result === "object" && result !== null ? Object.keys(result).join(", ") || "{}" : typeof result}`,
  );
};
