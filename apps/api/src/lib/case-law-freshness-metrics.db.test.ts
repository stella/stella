import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import "@/api/tests/setup-env";
import type { Transaction } from "@/api/db/root";
import {
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import { readCaseLawFreshnessReportTx } from "@/api/lib/observability/case-law-freshness-metrics";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v5";
const INDEX_ID = "case_law_v5_cs_sk";
const NOW = new Date();
const OLD = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
const ONE_HOUR_OLD = new Date(NOW.getTime() - 60 * 60 * 1000);
const ids = Array.from(
  { length: 8 },
  (_, index) =>
    `0198e331-e578-7000-8000-${String(index + 401).padStart(12, "0")}`,
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await db.insert(corpusIndexProjectionStates).values([
    {
      family: "case_law",
      generation: GENERATION,
      entityId: ids[0]!,
      desiredAction: "erase",
      desiredEpoch: 2n,
      appliedAction: "erase",
      appliedEpoch: 1n,
      appliedAt: NOW,
      createdAt: OLD,
      desiredAt: NOW,
    },
    {
      family: "case_law",
      generation: GENERATION,
      entityId: ids[1]!,
      desiredAction: "erase",
      desiredEpoch: 1n,
      appliedAction: "erase",
      appliedEpoch: 1n,
      appliedAt: NOW,
    },
    {
      family: "case_law",
      generation: GENERATION,
      entityId: ids[7]!,
      desiredAction: "erase",
      desiredEpoch: 1n,
      createdAt: ONE_HOUR_OLD,
      desiredAt: ONE_HOUR_OLD,
    },
  ]);
  await db.insert(corpusIndexProjectionIntents).values([
    {
      id: toSafeId<"corpusIndexProjectionIntent">(ids[2]!),
      family: "case_law",
      generation: GENERATION,
      entityId: ids[3]!,
      epoch: 1n,
      fingerprint: "a".repeat(64),
      indexId: INDEX_ID,
      status: "reserved",
      leaseToken: ids[4]!,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    },
    {
      id: toSafeId<"corpusIndexProjectionIntent">(ids[5]!),
      family: "case_law",
      generation: GENERATION,
      entityId: ids[6]!,
      epoch: 1n,
      fingerprint: "b".repeat(64),
      indexId: INDEX_ID,
      status: "cancelled",
      cancelledAt: NOW,
    },
  ]);
  await db.insert(caseLawSources).values([
    {
      id: toSafeId<"caseLawSource">(ids[0]!),
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "scheduled",
      lastSyncAt: OLD,
    },
    {
      id: toSafeId<"caseLawSource">(ids[1]!),
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      name: "never synced",
    },
    {
      id: toSafeId<"caseLawSource">(ids[2]!),
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      name: "import",
    },
    {
      id: toSafeId<"caseLawSource">(ids[3]!),
      adapterKey: ADAPTER_KEYS.CZ_US,
      name: "disabled",
      enabled: false,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("counts pending projections and reports only enabled scheduled-source freshness", async () => {
  const report = await db.transaction(
    async (tx) =>
      await readCaseLawFreshnessReportTx(asTestRaw<Transaction>(tx)),
  );

  expect(report.backlogItems).toBe(3);
  expect(report.oldestUnpublishedAgeSeconds).toBeGreaterThanOrEqual(3500);
  expect(report.oldestUnpublishedAgeSeconds).toBeLessThan(7100);
  expect(report.oldestUnpublishedAgeSource).toBe("desired_at");

  await db
    .update(corpusIndexProjectionStates)
    .set({ createdAt: OLD, desiredAt: null })
    .where(eq(corpusIndexProjectionStates.entityId, ids[7]!));
  const fallbackReport = await db.transaction(
    async (tx) =>
      await readCaseLawFreshnessReportTx(asTestRaw<Transaction>(tx)),
  );
  expect(fallbackReport.oldestUnpublishedAgeSeconds).toBeGreaterThanOrEqual(
    7100,
  );
  expect(fallbackReport.oldestUnpublishedAgeSource).toBe(
    "state_created_at_fallback",
  );
  expect(report.sourceAges.map(({ source }) => source).toSorted()).toEqual(
    [ADAPTER_KEYS.CZ_NS, ADAPTER_KEYS.CZ_NSS].toSorted(),
  );
  expect(
    report.sourceAges.find(({ source }) => source === ADAPTER_KEYS.CZ_NS)
      ?.ageSeconds,
  ).toBeGreaterThanOrEqual(7100);
  expect(
    report.sourceAges.find(({ source }) => source === ADAPTER_KEYS.CZ_NSS)
      ?.ageSeconds,
  ).toBeGreaterThan(1_000_000_000);
});
