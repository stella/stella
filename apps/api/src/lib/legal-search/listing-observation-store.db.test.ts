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
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
  plCourtsListingObservation,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { runListingCensus } from "@/api/handlers/case-law/ingestion/listing-census";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { createQuarantineCollisionRetention } from "@/api/handlers/case-law/ingestion/quarantine-collision-retention";
import {
  listReconciliationSlice,
  SLICE_LISTING_PROOF,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { storeListingObservations } from "@/api/lib/legal-search/listing-observation-store";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import type { ListingObservation } from "@/api/lib/legal-search/quarantine-identity";
import {
  LISTING_OBSERVATION_REASON,
  QUARANTINE_NAMESPACE,
  quarantinedListingObservation,
  quarantineIdentity,
} from "@/api/lib/legal-search/quarantine-identity";
import { fingerprintReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";
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

test.each([undefined, "Publisher source bytes"])(
  "reparsing %s keeps one persisted publisher revision across retention instances",
  async (sourceRaw) => {
    const sourceId = createSafeId<"caseLawSource">();
    const adapterKey =
      sourceRaw === undefined ? "quarantine-no-raw" : "quarantine-raw";
    await db
      .insert(caseLawSources)
      .values({ id: sourceId, adapterKey, name: "Reparse evidence fixture" });
    const { sourceDocumentId } = quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.CZ_NS,
      stableFields: { docket: "21 Cdo 701/2026" },
    });
    const decision = (id: string) =>
      plainTextIngestionResult({
        caseNumber: "21 Cdo 701/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        sourceDocumentId,
        metadata: { publisherLabel: "Original listing label" },
        fulltext: "Published text.",
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        sourceRaw,
        rawHash: `derived-${id}`,
        parserVersion: id.length,
        documentAst: {
          version: 1,
          source: {
            system: "test",
            documentId: sourceDocumentId,
            webUrl: "",
            printUrl: "",
          },
          metadata: {
            caseNumber: null,
            ecli: null,
            court: null,
            decisionDate: null,
            decisionType: null,
            keywords: [],
            statutes: [],
          },
          blocks: [
            {
              id,
              anchorId: id,
              type: "paragraph",
              inlines: [{ type: "text", text: "Published text." }],
              plainText: "Published text.",
            },
          ],
        },
      });
    const retain = async () => {
      const retention = createQuarantineCollisionRetention({
        adapterKey,
        persistCollisionEvidence: async (observations) => {
          await storeListingObservations(scopedDb, {
            sourceId,
            adapterKey,
            observations,
          });
        },
      });
      await retention.retainDecisions({
        type: "crawl",
        decisions: [decision("first"), decision("reparsed-block-id")],
        proof: { type: "no-listing-proof" },
      });
    };
    await retain();
    const read = async () =>
      await db
        .select()
        .from(caseLawListingObservations)
        .where(eq(caseLawListingObservations.sourceId, sourceId));
    const before = await read();
    expect(before).toHaveLength(1);
    expect(before[0]?.payload).toMatchObject({
      listing: {
        quarantineId: sourceDocumentId,
        record: {
          metadata: { publisherLabel: "Original listing label" },
          fulltext: "Published text.",
        },
      },
    });
    await retain();
    expect(await read()).toEqual(before);
  },
);

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
  expect(String(keyed.court)).toBe("Sąd powszechny");
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

test("a listing census retains collision evidence without double-counting its records", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "cz-ns",
    name: "Collision census source",
  });
  const { sourceDocumentId } = quarantineIdentity({
    namespace: QUARANTINE_NAMESPACE.CZ_NS,
    stableFields: { docket: "21 Cdo 3/2026" },
  });
  const records = [{ record: "first" }, { record: "second" }];
  const reconciliation = czNsAdapter.reconciliation;
  if (reconciliation === undefined) {
    panic("The fixture adapter lists reconciliation slices");
  }
  const date = new Date("2026-01-01T00:00:00.000Z");
  const result = (
    await runListingCensus({
      scopedDb,
      adapter: {
        ...czNsAdapter,
        reconciliation: {
          ...reconciliation,
          firstSlice: "2026-01-01",
          revisionOf: (payload) => payload,
          listSlicePage: async () => ({
            observations: [],
            items: records.map((payload) => ({
              identity: { type: "document" as const, sourceDocumentId },
              payload,
            })),
            totalPages: 1,
          }),
        },
      },
      from: date,
      to: date,
      now: date,
      maxSlices: 1,
      sleep: async () => undefined,
    })
  ).unwrap("The census stores its complete slice");
  expect(result).toMatchObject({ type: "completed", checkpoint: { total: 2 } });
  const evidence = await db
    .select()
    .from(caseLawListingObservations)
    .where(eq(caseLawListingObservations.sourceId, sourceId))
    .limit(10);
  expect(evidence).toHaveLength(2);
  expect(evidence.map(({ payload }) => payload)).toEqual(
    expect.arrayContaining(
      records.map((record) => ({
        listing: {
          quarantineId: sourceDocumentId,
          revision: fingerprintReconciliationPayload(record),
          record,
        },
      })),
    ),
  );
});

test("a completed slice retains every colliding payload and replay adds no duplicate", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "cz-regional",
    name: "Collision evidence source",
  });
  const quarantineId = `cz-regional-quarantine:${"d".repeat(64)}`;
  const first = { record: "first", listedField: "publisher value A" };
  const second = { record: "second", listedField: "publisher value B" };
  const third = { record: "third", listedField: "publisher value C" };
  const persistCollisionEvidence = async (
    observations: readonly ListingObservation[],
  ) =>
    await storeListingObservations(scopedDb, {
      sourceId,
      adapterKey: "cz-regional",
      observations,
    });
  const walk = async (payloads: readonly unknown[]) =>
    (
      await listReconciliationSlice({
        adapterKey: "cz-regional",
        proof: SLICE_LISTING_PROOF.IDENTITIES,
        revisionOf: (payload) => payload,
        persistCollisionEvidence,
        listSlicePage: async () => ({
          observations: [],
          items: payloads.map((payload) => ({
            identity: {
              type: "document" as const,
              sourceDocumentId: quarantineId,
            },
            payload,
          })),
          totalPages: 1,
        }),
        slice: "2026-01-01",
        pageDelayMs: 0,
        pageTimeoutMs: 5000,
        sleep: async () => undefined,
      })
    ).unwrap("The complete source slice is retained");
  const readEvidence = async () =>
    await db
      .select()
      .from(caseLawListingObservations)
      .where(eq(caseLawListingObservations.sourceId, sourceId))
      .orderBy(caseLawListingObservations.fingerprint)
      .limit(10);
  const listed = await walk([first, first, second]);
  expect([...listed.keyed.values()].map(({ payload }) => payload)).toEqual([
    first,
  ]);
  expect(listed.listed).toBe(3);
  expect(listed.duplicate).toBe(1);
  const before = await readEvidence();
  expect(before).toHaveLength(2);
  expect(before.map(({ payload }) => payload)).toEqual(
    expect.arrayContaining(
      [first, second].map((record) => ({
        listing: {
          quarantineId,
          revision: fingerprintReconciliationPayload(record),
          record,
        },
      })),
    ),
  );
  expect(before.map(({ reason }) => reason)).toEqual([
    "quarantine-collision",
    "quarantine-collision",
  ]);
  await walk([first, second]);
  expect(await readEvidence()).toEqual(before);
  await walk([first, second, third]);
  const afterThird = await readEvidence();
  expect(afterThird).toHaveLength(3);
  expect(afterThird.map(({ payload }) => payload)).toContainEqual({
    listing: {
      quarantineId,
      revision: fingerprintReconciliationPayload(third),
      record: third,
    },
  });
});
