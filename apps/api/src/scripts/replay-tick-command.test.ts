import { expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import { holdCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("unused database");
};

test("lease acquisition failure rejects without waiting for the work signal", async () => {
  const acquisitionError = new Error("lease database unavailable");
  const acquisition = holdCaseLawSourceIngestionLease(
    { scopedDb: unusedScopedDb, sourceId: createSafeId() },
    async () => {
      throw acquisitionError;
    },
  );
  const outcome = await Promise.race([
    acquisition.then(
      () => "resolved" as const,
      (error: unknown) => error,
    ),
    Promise.resolve()
      .then(() => undefined)
      .then(() => undefined)
      .then(() => undefined)
      .then(() => "still-pending" as const),
  ]);

  expect(outcome).toBe(acquisitionError);
});
