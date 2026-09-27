/**
 * How long a failing document stays out of the deferred document walk.
 *
 * Each attempt lengthens the decision's own cooldown, and past
 * `MAX_DOCUMENT_FETCH_ATTEMPTS` the decision is parked: out of both tiers,
 * counted, and back only through an explicit requeue. The fixture pairs a
 * decision just inside each boundary with one just outside it, so a
 * predicate that loosens or tightens either boundary fails here.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  countParkedDocuments,
  loadPendingDocuments,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
  parkDocumentFetch,
  requeueParkedDocuments,
} from "@/api/lib/legal-search/sk-document-backfill";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number): Date =>
  new Date(Date.now() - hours * HOUR_MS);

/** Wide enough to hold every row this file creates. */
const QUEUE_READ_LIMIT = 100;

type Seed = {
  label: string;
  attempts: number;
  attemptedAt: Date | null;
  /** Whether the walk may hand the decision out now. */
  eligible: boolean;
};

/**
 * The cooldown after attempt n is 6h × 2^(n-1), capped at 96h. Each pair
 * straddles one step of that schedule by a margin wide enough for the
 * test's own clock.
 */
const SEEDS: readonly Seed[] = [
  { label: "untried", attempts: 0, attemptedAt: null, eligible: true },
  {
    label: "1-cooling",
    attempts: 1,
    attemptedAt: hoursAgo(5),
    eligible: false,
  },
  { label: "1-cooled", attempts: 1, attemptedAt: hoursAgo(7), eligible: true },
  {
    label: "3-cooling",
    attempts: 3,
    attemptedAt: hoursAgo(23),
    eligible: false,
  },
  { label: "3-cooled", attempts: 3, attemptedAt: hoursAgo(25), eligible: true },
  {
    label: "7-cooling",
    attempts: 7,
    attemptedAt: hoursAgo(95),
    eligible: false,
  },
  { label: "7-cooled", attempts: 7, attemptedAt: hoursAgo(97), eligible: true },
  {
    label: "parked",
    attempts: MAX_DOCUMENT_FETCH_ATTEMPTS,
    attemptedAt: hoursAgo(24 * 365),
    eligible: false,
  },
];

let testDb: TestDatabase;
let scopedDb: ScopedDb;
let sourceId: SafeId<"caseLawSource">;
const seeded = new Map<string, SafeId<"caseLawDecision">>();
const suffix = Bun.randomUUIDv7().slice(0, 8);

const idFor = (label: string): SafeId<"caseLawDecision"> => {
  const id = seeded.get(label);
  if (id === undefined) {
    throw new Error(`fixture did not seed ${label}`);
  }
  return id;
};

const insertDecision = async (seed: Seed): Promise<void> => {
  const [row] = await testDb
    .insert(caseLawDecisions)
    .values({
      sourceId,
      caseNumber: `parking-${suffix}-${seed.label}`,
      court: "Okresný súd",
      country: "SVK",
      language: "sk",
      fulltext: null,
      documentUrl: `https://example.test/${seed.label}.pdf`,
      decisionDate: "2026-05-01",
      documentFetchAttempts: seed.attempts,
      documentFetchAttemptedAt: seed.attemptedAt,
    })
    .returning({ id: caseLawDecisions.id });
  if (!row) {
    throw new Error("expected decision row");
  }
  seeded.set(seed.label, row.id);
};

/** The seeded decisions the walk would hand out now. */
const queued = async (): Promise<Set<SafeId<"caseLawDecision">>> => {
  const ours = new Set(seeded.values());
  const queue = await loadPendingDocuments(scopedDb, QUEUE_READ_LIMIT);
  return new Set(queue.map(({ id }) => id).filter((id) => ours.has(id)));
};

beforeAll(async () => {
  testDb = await getTestDb();
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: TestDatabase) => Promise<unknown>) =>
      await callback(testDb),
  );

  const [source] = await testDb
    .insert(caseLawSources)
    .values({
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      name: `SK parking ${suffix}`,
      enabled: false,
    })
    .returning({ id: caseLawSources.id });
  if (!source) {
    throw new Error("expected source row");
  }
  sourceId = source.id;

  for (const seed of SEEDS) {
    await insertDecision(seed);
  }
}, 120_000);

afterAll(async () => {
  await testDb
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...seeded.values()]));
  await releaseTestDb();
});

test("each attempt lengthens the decision's own cooldown", async () => {
  const offered = await queued();

  for (const { label, eligible } of SEEDS) {
    expect({ label, offered: offered.has(idFor(label)) }).toEqual({
      label,
      offered: eligible,
    });
  }
});

test("a parked decision is counted and can be requeued", async () => {
  const parkedBefore = await countParkedDocuments(scopedDb, sourceId);
  expect(parkedBefore).toBeGreaterThanOrEqual(1);

  const requeued = await requeueParkedDocuments({
    scopedDb,
    sourceId,
    limit: 10,
  });

  expect(requeued).toBe(parkedBefore);
  expect(await countParkedDocuments(scopedDb, sourceId)).toBe(0);
  // Its last attempt was long ago, so it is due at once.
  expect(await queued()).toContain(idFor("parked"));
});

test("parking takes a decision out of the walk at once and keeps it pending", async () => {
  await insertDecision({
    label: "to-park",
    attempts: 1,
    attemptedAt: hoursAgo(24 * 365),
    eligible: true,
  });
  expect(await queued()).toContain(idFor("to-park"));
  const parkedBefore = await countParkedDocuments(scopedDb, sourceId);

  await parkDocumentFetch(idFor("to-park"), scopedDb);

  expect(await queued()).not.toContain(idFor("to-park"));
  expect(await countParkedDocuments(scopedDb, sourceId)).toBe(parkedBefore + 1);

  const row = await testDb.query.caseLawDecisions.findFirst({
    where: { id: { eq: idFor("to-park") } },
    columns: { fulltext: true, documentFetchAttempts: true },
  });
  expect(row).toEqual({
    fulltext: null,
    documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS,
  });
});
