import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawReconciliationItems,
  caseLawSources,
  relations,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import { fingerprintReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";
import {
  parkReconciliationItem,
  refreshTrackedReconciliationItems,
  retireReconciliationItem,
} from "@/api/lib/legal-search/reconciliation-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(async (tx) => await callback(asTestRaw(tx)));

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);
afterAll(async () => await client.close());

const readItem = async (
  sourceId: SafeId<"caseLawSource">,
  identityKey: string,
) => {
  const row = (
    await db
      .select()
      .from(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.identityKey, identityKey),
        ),
      )
      .limit(1)
  ).at(0);
  return (
    row ?? panic("Expected the tracked listing identity to remain durable")
  );
};

test(
  "missed listings reopen on corrected input and unchanged input preserves their retry state",
  async () => {
    await assertProperty(
      "reconciliation-tracked-listing-revision-sequence",
      fc.asyncProperty(
        fc.record({
          publisherValue: fc.jsonValue({ maxDepth: 3 }),
          language: fc.string({ minLength: 1, maxLength: 20 }),
          terminal: fc.boolean(),
          identityKind: fc.constantFrom("document", "case-number"),
        }),
        async ({ publisherValue, language, terminal, identityKind }) => {
          const sourceId = createSafeId<"caseLawSource">();
          const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
          const identityKey =
            listingIdentityKey(
              identityKind === "document"
                ? { type: "document", sourceDocumentId: "listing-sequence" }
                : {
                    type: "case-number",
                    caseNumber: "listing-sequence",
                    language,
                  },
            ) ?? panic("Expected a keyable listing identity");
          const slice = "2026-09-01";
          const now = new Date("2026-10-02T12:00:00Z");
          const oldPayload = { publisherValue, language, revision: 1 };
          const correctedPayload = { publisherValue, language, revision: 2 };
          const serializedCorrection = JSON.stringify(correctedPayload);
          const persistedCorrection: unknown = JSON.parse(serializedCorrection);
          await db
            .insert(caseLawSources)
            .values({
              id: sourceId,
              adapterKey: `revision-property-${sourceId}`,
              name: "Listing revision property fixture",
              ingestionLeaseToken: leaseToken,
              ingestionLeaseExpiresAt: new Date("2100-01-01T00:00:00Z"),
            });
          try {
            const miss = {
              sourceId,
              leaseToken,
              slice,
              identityKey,
              payload: oldPayload,
              errorTag: "detail-unavailable",
              now,
            };
            if (terminal) {
              await retireReconciliationItem(scopedDb, miss);
            } else {
              await parkReconciliationItem(scopedDb, miss);
            }
            const missed = await readItem(sourceId, identityKey);
            const unchanged = await refreshTrackedReconciliationItems(
              scopedDb,
              {
                sourceId,
                leaseToken,
                items: [{ slice, identityKey, payload: oldPayload }],
                now,
              },
            );
            if (unchanged.outcome !== "refreshed") {
              panic(
                "The revision property fixture must retain its source lease",
              );
            }
            expect(unchanged.refreshedIdentityKeys.has(identityKey)).toBe(
              false,
            );
            expect(await readItem(sourceId, identityKey)).toEqual(missed);

            // An older writer can replace a payload without replacing its revision fingerprint.
            await db
              .update(caseLawReconciliationItems)
              .set({
                payloadHash: fingerprintReconciliationPayload(correctedPayload),
              })
              .where(
                and(
                  eq(caseLawReconciliationItems.sourceId, sourceId),
                  eq(caseLawReconciliationItems.identityKey, identityKey),
                ),
              );
            const refreshed = await refreshTrackedReconciliationItems(
              scopedDb,
              {
                sourceId,
                leaseToken,
                items: [{ slice, identityKey, payload: correctedPayload }],
                now,
              },
            );
            if (refreshed.outcome !== "refreshed") {
              panic(
                "The revision property fixture must retain its source lease",
              );
            }
            expect(refreshed.trackedIdentityKeys.has(identityKey)).toBe(true);
            expect(refreshed.refreshedIdentityKeys.has(identityKey)).toBe(true);
            const reopened = await readItem(sourceId, identityKey);
            expect(reopened.payload).toEqual(persistedCorrection);
            expect(reopened.payloadHash).toBe(
              fingerprintReconciliationPayload(correctedPayload),
            );
            expect(reopened.status).toBe(RECONCILIATION_ITEM_STATUS.PARKED);
            expect(reopened.attempts).toBe(0);
            expect(reopened.lastError).toBeNull();
            expect(reopened.lastAttemptAt).toBeNull();
            expect(reopened.nextAttemptAt).toEqual(now);

            await parkReconciliationItem(scopedDb, {
              ...miss,
              payload: correctedPayload,
            });
            const retried = await readItem(sourceId, identityKey);
            expect(retried.attempts).toBe(1);
            expect(retried.nextAttemptAt?.getTime()).toBeGreaterThan(
              now.getTime(),
            );
            const repeated = await refreshTrackedReconciliationItems(scopedDb, {
              sourceId,
              leaseToken,
              items: [{ slice, identityKey, payload: correctedPayload }],
              now,
            });
            if (repeated.outcome !== "refreshed") {
              panic(
                "The revision property fixture must retain its source lease",
              );
            }
            expect(repeated.refreshedIdentityKeys.has(identityKey)).toBe(false);
            expect(await readItem(sourceId, identityKey)).toEqual(retried);
          } finally {
            await db
              .delete(caseLawSources)
              .where(eq(caseLawSources.id, sourceId));
          }
        },
      ),
      { numRuns: 25 },
    );
  },
  propertyTestTimeout(120_000),
);
