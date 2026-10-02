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
  RECONCILIATION_RETRY_DELAYS_MS,
  RECONCILIATION_TERMINAL_ATTEMPTS,
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

type RevisionSequenceOptions = {
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  identityKey: string;
  slice: string;
  now: Date;
  payload: { publisherValue: unknown; language: string; revision: number };
  actions: readonly ("miss" | "corrected" | "unchanged")[];
};

const assertRevisionSequence = async ({
  sourceId,
  leaseToken,
  identityKey,
  slice,
  now,
  payload,
  actions,
}: RevisionSequenceOptions) => {
  let currentPayload = payload;
  let attempts = 1;
  let previous = await readItem(sourceId, identityKey);
  for (const action of actions) {
    switch (action) {
      case "miss": {
        const result = await parkReconciliationItem(scopedDb, {
          sourceId,
          leaseToken,
          identityKey,
          slice,
          now,
          payload: currentPayload,
          errorTag: "detail-unavailable",
        });
        if (result.outcome !== "recorded") {
          panic("The revision property fixture must retain its source lease");
        }
        attempts += 1;
        expect(result.attempts).toBe(attempts);
        break;
      }
      case "corrected":
      case "unchanged": {
        if (action === "corrected") {
          currentPayload = {
            publisherValue: currentPayload.publisherValue,
            language: currentPayload.language,
            revision: currentPayload.revision + 1,
          };
          attempts = 0;
        }
        const result = await refreshTrackedReconciliationItems(scopedDb, {
          sourceId,
          leaseToken,
          now,
          items: [{ slice, identityKey, payload: currentPayload }],
        });
        if (result.outcome !== "refreshed") {
          panic("The revision property fixture must retain its source lease");
        }
        expect(result.trackedIdentityKeys.has(identityKey)).toBe(true);
        expect(result.refreshedIdentityKeys.has(identityKey)).toBe(
          action === "corrected",
        );
        break;
      }
      default: {
        const exhaustive: never = action;
        panic(`Unknown generated revision action: ${String(exhaustive)}`);
      }
    }
    const row = await readItem(sourceId, identityKey);
    const serializedPayload = JSON.stringify(currentPayload);
    const persistedPayload: unknown = JSON.parse(serializedPayload);
    expect(row.payload).toEqual(persistedPayload);
    expect(row.payloadHash).toBe(
      fingerprintReconciliationPayload(currentPayload),
    );
    expect(row.attempts).toBe(attempts);
    expect(row.status).toBe(
      attempts >= RECONCILIATION_TERMINAL_ATTEMPTS
        ? RECONCILIATION_ITEM_STATUS.TERMINAL
        : RECONCILIATION_ITEM_STATUS.PARKED,
    );
    if (action === "unchanged") {
      expect(row).toEqual(previous);
    } else if (action === "corrected") {
      expect(row.lastError).toBeNull();
      expect(row.lastAttemptAt).toBeNull();
      expect(row.nextAttemptAt).toEqual(now);
    } else {
      expect(row.lastError).toBe("detail-unavailable");
      expect(row.lastAttemptAt).toEqual(now);
      if (attempts >= RECONCILIATION_TERMINAL_ATTEMPTS) {
        expect(row.nextAttemptAt).toBeNull();
      } else {
        const delay =
          (
            row.nextAttemptAt ?? panic("A retryable miss must remain scheduled")
          ).getTime() - now.getTime();
        expect(delay).toBeGreaterThanOrEqual(RECONCILIATION_RETRY_DELAYS_MS[0]);
        expect(delay).toBeLessThanOrEqual(
          RECONCILIATION_RETRY_DELAYS_MS.at(-1) ??
            panic("A retry schedule needs an upper bound"),
        );
        expect(row.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
          previous.nextAttemptAt?.getTime() ?? now.getTime(),
        );
      }
    }
    previous = row;
  }
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
          actions: fc.array(fc.constantFrom("miss", "corrected", "unchanged"), {
            minLength: 1,
            maxLength: 8,
          }),
        }),
        async ({
          publisherValue,
          language,
          terminal,
          identityKind,
          actions,
        }) => {
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
          await db.insert(caseLawSources).values({
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
            await assertRevisionSequence({
              sourceId,
              leaseToken,
              identityKey,
              slice,
              now,
              payload: correctedPayload,
              actions,
            });
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
