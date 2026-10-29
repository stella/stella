import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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

test("source evidence is durable, immutable on replay, and never creates a canonical decision", async () => {
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
});
