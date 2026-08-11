/**
 * A `case_law_sources` row as the pipeline reads one.
 *
 * The pipeline takes a whole row, so every test that drives it has to supply
 * one, and a hand-written literal per test means the next column lands in as
 * many places as there are tests. Built here instead: the column set lives in
 * one place, and `satisfies` binds the literal to the schema, so a column
 * added, renamed or retyped fails to compile here rather than drifting.
 */

import type { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

type CaseLawSourceRow = typeof caseLawSources.$inferSelect;

const FIXED_TIMESTAMP = new Date("2026-01-01T00:00:00.000Z");

/** Fresh per call: the id is generated, so it cannot be a shared constant. */
const defaultCaseLawSourceRow = () =>
  ({
    id: createSafeId<"caseLawSource">(),
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "Test source",
    enabled: true,
    syncCursor: "cursor-1",
    lastSyncAt: null,
    observationOrder: 0n,
    checkpointObservationOrder: 0n,
    ingestionLeaseToken: null,
    ingestionLeaseExpiresAt: null,
    config: {},
    descriptor: null,
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  }) satisfies CaseLawSourceRow;

export const caseLawSourceRow = (
  overrides: Partial<CaseLawSourceRow> = {},
): CaseLawSourceRow => ({ ...defaultCaseLawSourceRow(), ...overrides });
