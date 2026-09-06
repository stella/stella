import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { PG_ERROR } from "@/api/lib/pg-error";
import { isRetriableBackfillFailure } from "@/api/lib/scheduler/tasks/corpus-index-job-detail-backfill";

/** A driver failure as the task meets it: wrapped by the query that raised it. */
const queryFailure = (sqlState: string) =>
  new DrizzleQueryError(
    "query failed",
    [],
    Object.assign(new Error("pg"), { errno: sqlState }),
  );

describe("corpus index-job detail backfill retries", () => {
  it("retries a page that was refused a lock, and only that", () => {
    expect(
      isRetriableBackfillFailure(
        queryFailure(PG_ERROR.LOCK_NOT_AVAILABLE),
        "page",
      ),
    ).toBe(true);
    // A page's statement budget is sized for a bounded write, so a page that
    // runs into it is not doing what it says and belongs in the failed runs.
    expect(
      isRetriableBackfillFailure(queryFailure(PG_ERROR.QUERY_CANCELED), "page"),
    ).toBe(false);
  });

  it("retries a validation that gave up on either of its budgets", () => {
    expect(
      isRetriableBackfillFailure(
        queryFailure(PG_ERROR.LOCK_NOT_AVAILABLE),
        "validate",
      ),
    ).toBe(true);
    expect(
      isRetriableBackfillFailure(
        queryFailure(PG_ERROR.QUERY_CANCELED),
        "validate",
      ),
    ).toBe(true);
  });

  it("reports anything else as the failure it is", () => {
    expect(
      isRetriableBackfillFailure(
        queryFailure(PG_ERROR.UNIQUE_VIOLATION),
        "validate",
      ),
    ).toBe(false);
    expect(isRetriableBackfillFailure(new Error("plain"), "page")).toBe(false);
  });
});
