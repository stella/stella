import { expect, test } from "bun:test";

import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@stll/case-law-ingestion-core/ingestion-constants";

import type { ScopedDb } from "@/api/db/safe-db";
import { recordImportSnapshot } from "@/api/handlers/case-law/ingestion/import-snapshot";

// Invalid input is refused before a transaction opens, so the database is
// never reached; reaching it is the failure.
const unreachableDb: ScopedDb = async () => {
  throw new Error("the database must not be reached");
};

test("a snapshot is recorded only for a bulk import source", async () => {
  const recorded = await recordImportSnapshot({
    scopedDb: unreachableDb,
    adapterKey: ADAPTER_KEYS.CZ_NS,
    snapshotDate: "2026-10-31",
  });
  expect(recorded.isErr()).toBe(true);
  expect(String(recorded.isErr() && recorded.error.message)).toContain(
    "not a bulk import source",
  );
});

test("a snapshot must be an ISO calendar day", async () => {
  for (const snapshotDate of [
    "2026-10-31T00:00:00Z",
    "2026-02-30",
    "",
    "31.10.2026",
  ]) {
    const recorded = await recordImportSnapshot({
      scopedDb: unreachableDb,
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      snapshotDate,
    });
    expect(recorded.isErr()).toBe(true);
    expect(String(recorded.isErr() && recorded.error.message)).toContain(
      "ISO calendar day",
    );
  }
});
