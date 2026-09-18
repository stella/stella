/**
 * The retry latency of the deferred document queue's remaining tier.
 *
 * A fetch that fails transiently leaves the decision pending and counts
 * an attempt, and the cooldown in the tier's predicate is what decides
 * when it may be tried again. Ordering the tier by attempt count first
 * silently overrode that: every decision that had failed once sorted
 * behind every decision still untried, so on a source whose backlog is
 * untried decisions the retry waited for the backlog to drain rather
 * than for the cooldown to pass.
 *
 * The fixture is that shape in miniature — one cooled failure among
 * untried decisions, dated between them — and asserts the failure is
 * served in its own date order rather than after every one of them.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { loadRemainingDocuments } from "@/api/lib/legal-search/sk-document-backfill";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const HOUR_MS = 60 * 60 * 1000;
/** Comfortably past the tier's cooldown, whatever it is set to. */
const COOLED_AT = new Date(Date.now() - 72 * HOUR_MS);

type Seed = {
  label: string;
  decisionDate: string;
  attempts: number;
  attemptedAt: Date | null;
};

/**
 * The cooled failure is dated between the untried decisions, so its
 * place in the tier is decided by the order under test rather than by
 * being the newest row in the fixture. `cooling` is the same failure
 * inside its cooldown, which must not be offered at all.
 */
const SEEDS: readonly Seed[] = [
  {
    label: "cooling",
    decisionDate: "2026-05-05",
    attempts: 1,
    attemptedAt: new Date(),
  },
  {
    label: "untried-newest",
    decisionDate: "2026-05-04",
    attempts: 0,
    attemptedAt: null,
  },
  {
    label: "untried-newer",
    decisionDate: "2026-05-03",
    attempts: 0,
    attemptedAt: null,
  },
  {
    label: "cooled-failure",
    decisionDate: "2026-05-02",
    attempts: 1,
    attemptedAt: COOLED_AT,
  },
  {
    label: "untried-older",
    decisionDate: "2026-05-01",
    attempts: 0,
    attemptedAt: null,
  },
  {
    label: "untried-oldest",
    decisionDate: "2026-04-30",
    attempts: 0,
    attemptedAt: null,
  },
];

/** The tier's expected order, newest decision first. */
const EXPECTED_LABELS = [
  "untried-newest",
  "untried-newer",
  "cooled-failure",
  "untried-older",
  "untried-oldest",
] as const;

let testDb: TestDatabase;
let scopedDb: ScopedDb;
let sourceId: SafeId<"caseLawSource">;
const created: SafeId<"caseLawDecision">[] = [];
const seeded = new Map<string, SafeId<"caseLawDecision">>();
const suffix = Bun.randomUUIDv7().slice(0, 8);

const idFor = (label: string): SafeId<"caseLawDecision"> => {
  const id = seeded.get(label);
  if (id === undefined) {
    throw new Error(`fixture did not seed ${label}`);
  }
  return id;
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
      name: `SK retry order ${suffix}`,
      enabled: false,
    })
    .returning({ id: caseLawSources.id });
  if (!source) {
    throw new Error("expected source row");
  }
  sourceId = source.id;

  for (const seed of SEEDS) {
    const [row] = await testDb
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `retry-${suffix}-${seed.label}`,
        court: "Okresný súd",
        country: "SVK",
        language: "sk",
        fulltext: null,
        documentUrl: `https://example.test/${seed.label}.pdf`,
        decisionDate: seed.decisionDate,
        documentFetchAttempts: seed.attempts,
        documentFetchAttemptedAt: seed.attemptedAt,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected decision row");
    }
    created.push(row.id);
    seeded.set(seed.label, row.id);
  }
}, 120_000);

afterAll(async () => {
  if (created.length > 0) {
    await testDb
      .delete(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, created));
  }
  await releaseTestDb();
});

const tier = async (): Promise<SafeId<"caseLawDecision">[]> => {
  const rows = await loadRemainingDocuments({
    scopedDb,
    sourceId,
    limit: SEEDS.length + 1,
  });
  return rows.map(({ id }) => id);
};

test("REGRESSION: a cooled failure is not queued behind the untried backlog", async () => {
  const order = await tier();

  // Its date, not its attempt count, decides where it sits: after the
  // two newer untried decisions and before the two older ones. Under an
  // attempt-led order it was last of the five.
  expect(order).toEqual(EXPECTED_LABELS.map((label) => idFor(label)));
});

test("the fixture would starve the retry under an attempt-led order", async () => {
  // Guards the assertion above against going vacuous: untried decisions
  // an attempt-led order would place ahead of the retry have to exist on
  // both sides of it, or the two orders agree and nothing is under test.
  const order = await tier();
  const retryIndex = order.indexOf(idFor("cooled-failure"));

  expect(retryIndex).toBeGreaterThan(0);
  expect(order.length - 1 - retryIndex).toBeGreaterThanOrEqual(2);
});

test("a failure still inside its cooldown stays out of the tier", async () => {
  // The cooldown is what bounds a document the source keeps refusing;
  // dropping the attempt count from the order must not loosen it.
  const order = await tier();

  expect(order).not.toContain(idFor("cooling"));
});
