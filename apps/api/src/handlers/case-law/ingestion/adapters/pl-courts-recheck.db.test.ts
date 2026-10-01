import { panic, Result } from "better-result";
/**
 * A SAOS judgment whose detail read failed, carried through the store and the
 * reconciliation engine: the crawl keeps the dump's text in public and states
 * the failed read on the row, the engine's walk of the judgment's date selects
 * that row although it is held, and a detail read that succeeds restates the
 * row as read and enriched.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DAY_IN_MS } from "@stll/time";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { SaosItem } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { plainTextIngestionResult } from "@/api/handlers/case-law/ingestion/adapters/plain-text-assembly";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  RECONCILIATION_INGEST_BUDGET_MS,
  runReconciliationWorkUnit,
  textlessHeldRecheckSelection,
} from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import { getCaseLawIngestionMetadata } from "@/api/handlers/case-law/metadata";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import type {
  SourceReconciliation,
  StoredRawResultReader,
} from "@/api/lib/legal-search/ingestion-types";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { planLines } from "@/api/tests/helpers/explain-plan";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let claimStatements = 0;
let leaseRenewals = 0;
const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
    logger: {
      logQuery(query) {
        if (
          query.startsWith('update "case_law_decisions"') &&
          query.includes('"textless_detail_rechecked_at"')
        ) {
          claimStatements += 1;
        }
        if (
          query.startsWith('update "case_law_sources"') &&
          query.includes("> now()")
        ) {
          leaseRenewals += 1;
        }
      },
    },
  });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let fake: FakeS3;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  claimStatements = 0;
  leaseRenewals = 0;
  fake = startFakeS3();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fake.stop();
});

const NOW = new Date();
const day = (offset: number): string =>
  toUtcDateString(addUtcDays(NOW, offset));
/** The judgment date the walk reconciles; also the walk's first slice. */
const SLICE = day(-5);

/** A real SAOS district-court record, carrying its text as the dump does. */
const JUDGMENT = {
  id: 130_600,
  href: "https://www.saos.org.pl/api/judgments/130600",
  courtType: "COMMON",
  courtCases: [{ caseNumber: "II Co 433/15" }],
  judgmentType: "DECISION",
  judgmentDate: SLICE,
  textContent: "<p>Sąd Rejonowy postanawia oddalić wniosek.</p>",
  division: {
    id: 203,
    name: "II Wydział Cywilny Sekcja Egzekucyjna",
    court: { id: 36, code: "15050505", name: "Sąd Rejonowy w Białymstoku" },
  },
} as const satisfies SaosItem;

const RAPPORTEUR = "Anna Nowak";

/** SAOS, with the per-judgment endpoint answering as `detail` says. */
const serveSaos = (detail: () => Response): void => {
  globalThis.fetch = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://www.saos.org.pl/")) {
        return await originalFetch(input, init);
      }
      if (url.includes("/api/dump/judgments")) {
        return Response.json({ items: [JUDGMENT] });
      }
      if (url.includes("/api/search/judgments")) {
        return Response.json({
          items: [JUDGMENT],
          info: { totalResults: 1 },
        });
      }
      if (url.endsWith(`/api/judgments/${JUDGMENT.id}`)) {
        return detail();
      }
      return new Response("Not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );
};

const seedSource = async (): Promise<SafeId<"caseLawSource">> => {
  const id = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id,
    adapterKey: `pl-courts-recheck-${id}`,
    name: "pl-courts recheck fixture",
    config: {},
    // The crawl's write below takes the first observation order.
    observationOrder: 1n,
  });
  return id;
};

/** A fresh tip, and the judgment's date as a stale slice owing one record. */
const seedLedger = async (sourceId: SafeId<"caseLawSource">): Promise<void> => {
  const rows = [
    { slice: day(0), reported: 0, collected: 0, checkedAt: NOW },
    { slice: day(-1), reported: 0, collected: 0, checkedAt: NOW },
    { slice: SLICE, reported: 1, collected: 0, checkedAt: addUtcDays(NOW, -2) },
  ];
  for (const row of rows) {
    await db.insert(caseLawCoverageSlices).values({
      id: createSafeId<"caseLawCoverageSlice">(),
      sourceId,
      ...row,
    });
  }
};

/** The adapter's own reconciliation, over a walk of recent days. */
const reconciliation: SourceReconciliation = {
  ...requireReconciliation(plCourtsAdapter),
  firstSlice: SLICE,
  sliceOf: toUtcDateString,
  nextSlice: (slice) => {
    const next = toUtcDateString(
      addUtcDays(new Date(`${slice}T00:00:00.000Z`), 1),
    );
    return next > day(0) ? null : next;
  },
  previousSlice: (slice) => {
    const previous = toUtcDateString(
      addUtcDays(new Date(`${slice}T00:00:00.000Z`), -1),
    );
    return previous < SLICE ? null : previous;
  },
  tipWindowDays: 2,
};

const storedRow = async (sourceId: SafeId<"caseLawSource">) => {
  const [row] = await db
    .select({
      metadata: caseLawDecisions.metadata,
      fulltext: caseLawDecisions.fulltext,
      textlessDetailRecheckedAt: caseLawDecisions.textlessDetailRecheckedAt,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  if (row === undefined) {
    throw new Error("expected the judgment to be stored");
  }
  return { ...row, metadata: row.metadata ?? {} };
};

const seedTextlessListing = async (
  sourceId: SafeId<"caseLawSource">,
  updatedAt: Date,
): Promise<void> => {
  serveSaos(() => new Response("temporarily unavailable", { status: 503 }));
  const crawled = (await plCourtsAdapter.fetchPage(null, {})).unwrap()
    .decisions[0];
  if (crawled === undefined) {
    throw new Error("expected the listing to build the judgment");
  }
  await processDecision({
    input: plainTextIngestionResult({
      ...crawled,
      fulltext: undefined,
      sections: undefined,
      documentAst: EMPTY_AST,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      isListingOnly: true,
      metadata: {
        ...crawled.metadata,
        detailReadState: "read",
      },
    }),
    sourceId,
    scopedDb,
    observedAt: updatedAt,
    observationOrder: 1n,
  });
  await db
    .update(caseLawDecisions)
    .set({ updatedAt })
    .where(eq(caseLawDecisions.sourceId, sourceId));
};

const seedSettledLedger = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  for (const slice of [day(0), day(-1), SLICE]) {
    await db.insert(caseLawCoverageSlices).values({
      id: createSafeId<"caseLawCoverageSlice">(),
      sourceId,
      slice,
      reported: 0,
      collected: 0,
      checkedAt: NOW,
    });
  }
};

type SeedTextlessQueueOptions = {
  sourceId: SafeId<"caseLawSource">;
  count: number;
  updatedAt: Date;
};
const seedTextlessQueue = async ({
  sourceId,
  count,
  updatedAt,
}: SeedTextlessQueueOptions) => {
  await db.insert(caseLawDecisions).values(
    Array.from({ length: count }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `recheck-${index}`,
      court: "Sąd Rejonowy w Białymstoku",
      country: "PL",
      language: "pl",
      sourceDocumentId: `saos-recheck-${index}`,
      sourceRawS3Key: "textless-recheck-fixture",
      sourceRawContentType: "application/json",
      updatedAt,
      metadata: {
        detailReadState: "read",
        [PARTIAL_OBSERVATION_KEY]: {
          [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
        },
      },
    })),
  );
};

type RunUnitOptions = {
  sourceId: SafeId<"caseLawSource">;
  readStoredRaw?: StoredRawResultReader;
  now?: () => Date;
};
const runUnit = async ({
  sourceId,
  readStoredRaw,
  now = () => NOW,
}: RunUnitOptions) =>
  await runReconciliationWorkUnit({
    adapterKey: "pl-courts",
    sourceId,
    reconciliation,
    reparseStoredRaw: undefined,
    scopedDb,
    now,
    fetchDelayMs: 0,
    sleep: async () => {
      await Promise.resolve();
    },
    sliceRetries: new Map(),
    readStoredRaw,
  });

test("a judgment whose detail read failed is read again by the reconciliation and settles enriched", async () => {
  const sourceId = await seedSource();

  // The crawl: SAOS fails the detail read, and the dump row is stored.
  serveSaos(() => new Response("upstream failure", { status: 503 }));
  const crawled = (await plCourtsAdapter.fetchPage(null, {})).unwrap()
    .decisions[0];
  if (crawled === undefined) {
    throw new Error("expected the crawl to build the judgment");
  }
  const stored = await processDecision({
    input: crawled,
    sourceId,
    scopedDb,
    observedAt: NOW,
    observationOrder: 1n,
  });
  expect(stored.status).toBe("complete");
  const before = await storedRow(sourceId);
  expect(before.fulltext).toContain("oddalić wniosek");
  expect(partialObservationFromMetadata(before.metadata).isListingOnly).toBe(
    false,
  );
  expect(before.metadata["detailReadState"]).toBe("failed");

  // The walk of the judgment's date: SAOS now answers the detail.
  await seedLedger(sourceId);
  serveSaos(() =>
    Response.json({
      data: { ...JUDGMENT, judges: [{ name: RAPPORTEUR }] },
    }),
  );
  const outcome = await runReconciliationWorkUnit({
    adapterKey: "pl-courts",
    sourceId,
    reconciliation,
    reparseStoredRaw: undefined,
    scopedDb,
    now: () => NOW,
    fetchDelayMs: 0,
    sleep: async () => {
      await Promise.resolve();
    },
    sliceRetries: new Map(),
  });

  // The held row was selected, built from its detail and written.
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: SLICE, keyable: 1, heldBefore: 0, written: 1 },
  });
  const after = await storedRow(sourceId);
  expect(after.metadata["detailReadState"]).toBe("read");
  expect(getCaseLawIngestionMetadata(after.metadata)?.sourceTier).toBe(
    "detail",
  );
  expect(JSON.stringify(after.metadata["judges"])).toContain(RAPPORTEUR);
  expect(after.fulltext).toContain("oddalić wniosek");
});

test("textless listing-only rows become due after seven days and publish recovered detail once", async () => {
  const sourceId = await seedSource();
  await seedTextlessListing(sourceId, new Date(NOW.getTime() - 8 * DAY_IN_MS));
  await seedSettledLedger(sourceId);

  let detailReads = 0;
  serveSaos(() => {
    detailReads += 1;
    return Response.json({
      data: { ...JUDGMENT, judges: [{ name: RAPPORTEUR }] },
    });
  });

  const outcome = await runUnit({ sourceId });
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { unit: "textless-detail-rechecks", keyable: 1, written: 1 },
  });
  const restored = await storedRow(sourceId);
  expect(restored.textlessDetailRecheckedAt).toEqual(NOW);
  expect(restored.fulltext).toContain("oddalić wniosek");
  expect(partialObservationFromMetadata(restored.metadata).isListingOnly).toBe(
    false,
  );
  expect(getCaseLawIngestionMetadata(restored.metadata)?.sourceTier).toBe(
    "detail",
  );
  expect(detailReads).toBe(1);

  expect(await runUnit({ sourceId })).toEqual({ type: "idle" });
  expect(detailReads).toBe(1);
});

test("textless listing-only rows younger than seven days remain untouched", async () => {
  const sourceId = await seedSource();
  await seedTextlessListing(sourceId, new Date(NOW.getTime() - 6 * DAY_IN_MS));
  await seedSettledLedger(sourceId);
  let detailReads = 0;
  serveSaos(() => {
    detailReads += 1;
    return Response.json({ data: { ...JUDGMENT } });
  });

  expect(await runUnit({ sourceId })).toEqual({ type: "idle" });
  const row = await storedRow(sourceId);
  expect(row.textlessDetailRecheckedAt).toBeNull();
  expect(row.fulltext).toBeNull();
  expect(detailReads).toBe(0);
});

test("textless held rechecks claim each capped page in one statement before reading raw", async () => {
  const sourceId = await seedSource();
  const old = new Date(NOW.getTime() - 8 * DAY_IN_MS);
  await seedTextlessQueue({ sourceId, count: 205, updatedAt: old });
  await seedSettledLedger(sourceId);

  // Published rows make the due queue a small fraction of the corpus,
  // rather than requiring an index scan over a tiny all-eligible table.
  const publishedSourceId = await seedSource();
  await db.insert(caseLawDecisions).values(
    Array.from({ length: 3000 }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId: publishedSourceId,
      caseNumber: `published-${index}`,
      court: "Synthetic court",
      country: "PL",
      language: "pl",
      fulltext: "Published decision text.",
    })),
  );
  const recheck = reconciliation.textlessHeldRecheck;
  if (recheck === undefined) {
    panic("expected the adapter's textless recheck capability");
  }
  await db.execute(sql`ANALYZE case_law_decisions`);
  const explained = await scopedDb(
    async (tx) =>
      await tx.execute(sql`
      EXPLAIN ${textlessHeldRecheckSelection({
        tx,
        sourceId,
        before: new Date(NOW.getTime() - 7 * DAY_IN_MS),
        recheck,
        limit: 200,
      })}
    `),
  );
  const plan = planLines(explained).join("\n");
  expect(plan).toContain("case_law_decisions_textless_detail_recheck_idx");
  expect(plan).not.toContain("Seq Scan");

  let rawReads = 0;
  let claimsBeforeFirstRead: number | undefined;
  const readMissingRaw: StoredRawResultReader = async () => {
    if (rawReads === 0) {
      claimsBeforeFirstRead = claimStatements;
    }
    rawReads += 1;
    return Result.ok(null);
  };
  const outcome = await runUnit({ sourceId, readStoredRaw: readMissingRaw });
  const attempts = await db
    .select({ id: caseLawDecisions.id, updatedAt: caseLawDecisions.updatedAt })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  const claimed = await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        eq(caseLawDecisions.textlessDetailRecheckedAt, NOW),
      ),
    );

  expect(outcome).toMatchObject({
    type: "worked",
    summary: { unit: "textless-detail-rechecks", keyable: 200 },
  });
  expect(attempts).toHaveLength(205);
  expect(
    attempts.every(({ updatedAt }) => updatedAt.getTime() === old.getTime()),
  ).toBe(true);
  expect(claimed).toHaveLength(200);
  expect(rawReads).toBe(200);
  expect(claimStatements).toBe(1);
  expect(claimsBeforeFirstRead).toBe(1);

  const nextUnit = await runUnit({ sourceId, readStoredRaw: readMissingRaw });
  expect(nextUnit).toMatchObject({
    type: "worked",
    summary: { unit: "textless-detail-rechecks", keyable: 5 },
  });
  expect(rawReads).toBe(205);
  expect(claimStatements).toBe(2);
});

test("textless rechecks renew the lease on missing raw and stop at the ingest deadline", async () => {
  const sourceId = await seedSource();
  await seedTextlessQueue({
    sourceId,
    count: 3,
    updatedAt: new Date(NOW.getTime() - 8 * DAY_IN_MS),
  });
  await seedSettledLedger(sourceId);
  let clock = NOW;
  let rawReads = 0;
  let renewalsAtRead: number | undefined;
  const outcome = await runUnit({
    sourceId,
    now: () => clock,
    readStoredRaw: async () => {
      rawReads += 1;
      renewalsAtRead = leaseRenewals;
      clock = new Date(NOW.getTime() + RECONCILIATION_INGEST_BUDGET_MS);
      return Result.ok(null);
    },
  });
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { keyable: 3, failed: 1, deferred: 2 },
  });
  expect(rawReads).toBe(1);
  expect(renewalsAtRead).toBe(2);
  const rows = await db
    .select({ attemptedAt: caseLawDecisions.textlessDetailRecheckedAt })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  expect(rows).toHaveLength(3);
  expect(
    rows.every(({ attemptedAt }) => attemptedAt?.getTime() === NOW.getTime()),
  ).toBe(true);
});
