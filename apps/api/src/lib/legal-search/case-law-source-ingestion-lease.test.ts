import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";

import { holdCaseLawSourceIngestionLease } from "./case-law-source-ingestion-lease";

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("unused database");
};

// A held lease resolves only once its work starts; a failed acquisition must
// reject the hold rather than wait for a start that never comes.
test("a failed acquisition rejects the hold instead of waiting for its work", async () => {
  const acquisitionError = new Error("lease database unavailable");
  const hold = holdCaseLawSourceIngestionLease(
    { scopedDb: unusedScopedDb, sourceId: createSafeId() },
    async () => {
      throw acquisitionError;
    },
  );

  expect(await rejectionOf(hold)).toBe(acquisitionError);
});
