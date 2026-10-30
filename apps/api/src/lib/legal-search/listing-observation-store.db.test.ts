import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawListingObservations,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
  plCourtsListingObservation,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { runListingCensus } from "@/api/handlers/case-law/ingestion/listing-census";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { createSafeId } from "@/api/lib/branded-types";
import { storeListingObservations } from "@/api/lib/legal-search/listing-observation-store";
import {
  LISTING_OBSERVATION_REASON,
  QUARANTINE_NAMESPACE,
  quarantinedListingObservation,
} from "@/api/lib/legal-search/quarantine-identity";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const { createTestPglite } = await import("@/api/tests/pglite-test-db");
const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(
    async (tx) => await callback(asTestRaw<Transaction>(tx)),
  );
beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
});
afterAll(async () => await client.close());

test("source evidence is durable, queryable, and separate from canonical decisions", async () => {
  const first = createSafeId<"caseLawSource">();
  const second = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values([
    { id: first, adapterKey: "sk-us", name: "First observation source" },
    { id: second, adapterKey: "pl-courts", name: "Second observation source" },
  ]);
  const payload = {
    documentId: null,
    originalField: ["Publisher value", null],
  };
  const observation = quarantinedListingObservation({
    source: QUARANTINE_NAMESPACE.SK_US,
    payload,
    reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
  });
  const options = {
    sourceId: first,
    adapterKey: "sk-us",
    observations: [observation],
  };
  await storeListingObservations(scopedDb, options);
  const before = await db
    .select()
    .from(caseLawListingObservations)
    .where(eq(caseLawListingObservations.sourceId, first))
    .limit(10);
  await storeListingObservations(scopedDb, {
    ...options,
    observations: [observation, observation],
  });
  const after = await db
    .select()
    .from(caseLawListingObservations)
    .where(eq(caseLawListingObservations.sourceId, first))
    .limit(10);
  expect(after).toEqual(before);
  expect(after).toHaveLength(1);
  expect(after.at(0)?.payload).toEqual({ listing: payload });
  expect(after.at(0)?.reason).toBe("no-usable-id");
  await storeListingObservations(scopedDb, {
    sourceId: second,
    adapterKey: "pl-courts",
    observations: [
      quarantinedListingObservation({
        source: QUARANTINE_NAMESPACE.PL_COURTS,
        payload,
        reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
      }),
    ],
  });
  expect(
    await db
      .select()
      .from(caseLawListingObservations)
      .where(eq(caseLawListingObservations.sourceId, second))
      .limit(10),
  ).toHaveLength(1);
  expect(
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, first))
      .limit(1),
  ).toEqual([]);
  const reconciliation = skUsAdapter.reconciliation;
  if (reconciliation === undefined) {
    return panic("SK-US supports listing reconciliation");
  }
  const censusObservation = quarantinedListingObservation({
    source: "sk-us",
    payload: { retainedBy: "listing census" },
    reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
  });
  const date = new Date("2026-01-01T00:00:00.000Z");
  const census = await runListingCensus({
    scopedDb,
    adapter: {
      ...skUsAdapter,
      reconciliation: {
        ...reconciliation,
        firstSlice: "2026-01",
        listSlicePage: async () => ({
          items: [],
          observations: [censusObservation],
          totalPages: 1,
        }),
      },
    },
    from: date,
    to: date,
    now: date,
    maxSlices: 1,
    sleep: async () => undefined,
  });
  expect(census.unwrap("The census completes its configured range").type).toBe(
    "completed",
  );
  const censusEvidence = await db
    .select()
    .from(caseLawListingObservations)
    .where(eq(caseLawListingObservations.sourceId, first))
    .limit(10);
  expect(
    censusEvidence.map(({ payload: storedPayload }) => storedPayload),
  ).toContainEqual({
    listing: censusObservation.payload,
  });

  const courtlessPayload = {
    id: null,
    courtCases: [],
    courtType: null,
    division: null,
    judgmentDate: null,
    judgmentType: null,
    judges: [],
  };
  const courtlessObservation = plCourtsListingObservation(courtlessPayload);
  if (courtlessObservation === null) {
    return panic("the courtless item has no stable listing identity");
  }
  await storeListingObservations(scopedDb, {
    sourceId: second,
    adapterKey: "pl-courts",
    observations: [courtlessObservation],
  });
  const courtlessEvidence = await db
    .select({
      fingerprint: caseLawListingObservations.fingerprint,
      payload: caseLawListingObservations.payload,
      reason: caseLawListingObservations.reason,
    })
    .from(caseLawListingObservations)
    .where(
      and(
        eq(caseLawListingObservations.sourceId, second),
        eq(
          caseLawListingObservations.fingerprint,
          courtlessObservation.identity.fingerprint,
        ),
      ),
    );
  expect(courtlessEvidence).toEqual([
    {
      fingerprint: courtlessObservation.identity.fingerprint,
      payload: { listing: courtlessPayload },
      reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
    },
  ]);

  const listingItem = normalizeSaosDumpItem({
    id: 91_004,
    courtCases: [{ caseNumber: "II Co 3/2026" }],
    courtType: "COMMON",
    judgmentDate: "2026-01-01",
    judgmentType: "DECISION",
  });
  const keyed = buildPlDecision({
    listingItem,
    detail: null,
    rawParts: { "listing-dump": JSON.stringify(listingItem) },
  });
  if (keyed === null) {
    return panic("the keyed PL-Courts item builds a decision");
  }
  expect(keyed.court).toBe("Sąd powszechny");
  expect(keyed.sourceDocumentId).toBe("91004");

  await processDecision({
    input: {
      ...keyed,
      sourceRaw: undefined,
      sourceRawBytes: undefined,
      sourceRawContentType: undefined,
    },
    observationOrder: 1n,
    sourceId: second,
    scopedDb,
    observedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  const decisions = await db
    .select({
      sourceDocumentId: caseLawDecisions.sourceDocumentId,
      court: caseLawDecisions.court,
      caseNumber: caseLawDecisions.caseNumber,
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, second),
        eq(caseLawDecisions.court, "Sąd powszechny"),
        eq(caseLawDecisions.caseNumber, "II Co 3/2026"),
      ),
    );
  expect(decisions).toEqual([
    {
      sourceDocumentId: "91004",
      court: "Sąd powszechny",
      caseNumber: "II Co 3/2026",
    },
  ]);
  expect(
    await db
      .select({ fingerprint: caseLawListingObservations.fingerprint })
      .from(caseLawListingObservations)
      .where(
        and(
          eq(caseLawListingObservations.sourceId, second),
          eq(
            caseLawListingObservations.fingerprint,
            courtlessObservation.identity.fingerprint,
          ),
        ),
      ),
  ).toEqual([{ fingerprint: courtlessObservation.identity.fingerprint }]);
});
