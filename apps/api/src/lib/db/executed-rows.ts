import { isRecord } from "@/api/lib/type-guards";

/**
 * Rows from `execute` under either driver shape.
 *
 * The server driver yields the rows directly; pglite, which the database tests
 * run on, wraps them in `{ rows }`. A reader that assumes one shape works in
 * exactly one of the two places, so a query verified by a test can still return
 * nothing in production, and the reverse. Every caller of `execute` that reads
 * rows back goes through here so neither half can be forgotten.
 */
export const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};
