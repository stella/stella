import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { SOURCE_DOCUMENT_ID_MAX_LENGTH } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { applyCaseLawIngestionBatch } from "@/api/handlers/case-law/ingestion/pipeline/batch";
import {
  CASE_LAW_BATCH_BOUNDS_REASON,
  CASE_LAW_BATCH_FAILURE,
  CASE_LAW_INGESTION_BATCH_LIMITS,
  prepareCaseLawIngestionBatch,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { CorpusPackError } from "@/api/lib/legal-search/corpus-pack";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// One batch application behind two callers: a crawl page and a caller that
// hands over records it already holds. Whatever stops a batch short of every
// record settling, neither may certify it (no receipt, no cursor movement),
// and applying the same records again converges.

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
}, 120_000);

afterAll(async () => {
  await client.close();
});

const originalFetchPage = czNsAdapter.fetchPage;

afterEach(() => {
  czNsAdapter.fetchPage = originalFetchPage;
});

type PutPacks = (packs: readonly EncodedPack[]) => Promise<void>;

type Transfer = {
  corpus: CaseLawCorpusDependencies;
  /** Every pack the transfer accepted. */
  landed: EncodedPack[];
};

/** A pack transfer that lands, after running `before` on the packs. */
const landingTransfer = (before?: PutPacks): Transfer => {
  const landed: EncodedPack[] = [];
  return {
    landed,
    corpus: {
      mode: "canonical",
      transfer: {
        layout: "packs",
        putPacks: async ({ packs }) => {
          await before?.(packs);
          landed.push(...packs);
          return Result.ok(undefined);
        },
      },
    },
  };
};

const failingTransfer = (): CaseLawCorpusDependencies => ({
  mode: "canonical",
  transfer: {
    layout: "packs",
    putPacks: async () =>
      await Promise.resolve(
        Result.err(new CorpusPackError({ message: "bucket unreachable" })),
      ),
  },
});

const record = (n: number): IngestionResult => ({
  caseNumber: `4 As ${n}/2008`,
  sourceDocumentId: `batch-record-${n}`,
  court: "Nejvyšší správní soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2008-12-18",
  decisionType: "rozsudek",
  fulltext: `Nejvyšší správní soud rozhodl v právní věci žalobkyně č. ${n}.`,
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: `batch-record-hash-${n}`,
  documentAst: {},
});

const records = (count: number): IngestionResult[] =>
  Array.from({ length: count }, (_, n) => record(n + 1));

/** A record the ingestion boundary refuses: its identity cannot be stored. */
const rejectedRecord = (): IngestionResult => ({
  ...record(99),
  sourceDocumentId: "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
});

/**
 * A source for the crawl. Its adapter key must name a registered adapter,
 * and the key is unique, so the source a previous test used gives it up.
 */
const crawlSource = async (): Promise<SafeId<"caseLawSource">> => {
  await db
    .update(caseLawSources)
    .set({ adapterKey: sql`'retired-' || ${caseLawSources.id}` })
    .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.CZ_NS));
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "batch application crawl fixture",
  });
  return sourceId;
};

const recordSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `batch-application-${sourceId}`,
    name: "batch application fixture",
  });
  return sourceId;
};

const sourceCursor = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<string | null> => {
  const row =
    (
      await db
        .select({ cursor: caseLawSources.syncCursor })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
    ).at(0) ?? panic("the source row is gone");
  return row.cursor;
};

const decisionRows = async (sourceId: SafeId<"caseLawSource">) =>
  await db
    .select({
      id: caseLawDecisions.id,
      sourceDocumentId: caseLawDecisions.sourceDocumentId,
      sourceHash: caseLawDecisions.sourceHash,
      corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
      textKey: caseLawDecisions.textS3Key,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId))
    .orderBy(asc(caseLawDecisions.sourceDocumentId));

const ledgerRows = async (sourceId: SafeId<"caseLawSource">) =>
  await db
    .select({ caseNumber: caseLawIngestionFailures.caseNumber })
    .from(caseLawIngestionFailures)
    .where(eq(caseLawIngestionFailures.sourceId, sourceId));

/** Take the source's lease away from whoever holds it. */
const loseLease = async (sourceId: SafeId<"caseLawSource">): Promise<void> => {
  await db
    .update(caseLawSources)
    .set({ ingestionLeaseToken: null, ingestionLeaseExpiresAt: null })
    .where(eq(caseLawSources.id, sourceId));
};

/**
 * Fail every failure-ledger insert the way a serialization conflict does,
 * for the duration of `run`.
 */
const withUnwritableLedger = async <T>(run: () => Promise<T>): Promise<T> => {
  await db.execute(
    sql.raw(`
      CREATE FUNCTION batch_application_reject_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger unavailable' USING ERRCODE = '40001';
      END
      $$
    `),
  );
  await db.execute(
    sql.raw(`
      CREATE TRIGGER batch_application_reject_ledger
        BEFORE INSERT ON case_law_ingestion_failures
        FOR EACH ROW EXECUTE FUNCTION batch_application_reject_ledger()
    `),
  );
  try {
    return await run();
  } finally {
    await db.execute(
      sql.raw(
        "DROP TRIGGER batch_application_reject_ledger ON case_law_ingestion_failures",
      ),
    );
    await db.execute(
      sql.raw("DROP FUNCTION batch_application_reject_ledger()"),
    );
  }
};

type Applied =
  | { type: "certified"; applied: number | null }
  | { type: "held"; detail: string };

type ApplyOptions = {
  sourceId: SafeId<"caseLawSource">;
  decisions: readonly IngestionResult[];
  corpus: CaseLawCorpusDependencies;
};

type Caller = {
  name: string;
  source: () => Promise<SafeId<"caseLawSource">>;
  /** Apply the records once, under a lease of its own. */
  apply: (options: ApplyOptions) => Promise<Applied>;
  /** What a certification reports as applied, where the caller counts it. */
  appliedCount: (count: number) => number | null;
  /** How the caller names a failed pack and a lost lease. */
  heldFor: { pack: string; lease: string };
};

const leaseFor = async (sourceId: SafeId<"caseLawSource">) =>
  (await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId })) ??
  panic("expected the source lease to be free");

/** Certified when the page's cursor was checkpointed. */
const crawlCaller: Caller = {
  name: "a crawl page",
  source: crawlSource,
  apply: async ({ sourceId, decisions, corpus }) => {
    const sourceLease = await leaseFor(sourceId);
    const nextCursor = `${sourceLease.source.syncCursor ?? "page"}+`;
    czNsAdapter.fetchPage = async () =>
      await Promise.resolve(
        Result.ok({ decisions: [...decisions], nextCursor }),
      );
    const run = await Result.tryPromise({
      try: async () =>
        await runIngestionPipeline({
          source: sourceLease.source,
          sourceLease,
          scopedDb,
          maxPages: 1,
          corpus,
        }),
      catch: (cause) => cause,
    });
    await sourceLease.release();
    if (Result.isError(run)) {
      return { type: "held", detail: String(run.error) };
    }
    return (await sourceCursor(sourceId)) === nextCursor
      ? { type: "certified", applied: null }
      : { type: "held", detail: run.value.haltReason ?? "" };
  },
  appliedCount: () => null,
  heldFor: {
    pack: "corpus write failure(s); cursor held for retry",
    lease: "lease was lost",
  },
};

/** Certified by the receipt. */
const directCaller: Caller = {
  name: "records applied directly",
  source: recordSource,
  apply: async ({ sourceId, decisions, corpus }) => {
    const sourceLease = await leaseFor(sourceId);
    const prepared = prepareCaseLawIngestionBatch({ decisions });
    if (Result.isError(prepared)) {
      return panic(prepared.error.message);
    }
    const applied = await applyCaseLawIngestionBatch({
      batch: prepared.value,
      sourceLease,
      scopedDb,
      signal: new AbortController().signal,
      refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus,
    });
    await sourceLease.release();
    return Result.isOk(applied)
      ? { type: "certified", applied: applied.value.applied }
      : { type: "held", detail: applied.error.reason };
  },
  appliedCount: (count) => count,
  heldFor: {
    pack: CASE_LAW_BATCH_FAILURE.PACK_WRITE,
    lease: CASE_LAW_BATCH_FAILURE.LEASE_LOST,
  },
};

const settledRows = (count: number) =>
  Array.from({ length: count }, () =>
    expect.objectContaining({
      corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
    }),
  );

describe.each([crawlCaller, directCaller])("$name", (caller) => {
  test("settles every record, and applying them again is a fixed point", async () => {
    const sourceId = await caller.source();
    const { corpus, landed } = landingTransfer();

    expect(
      await caller.apply({ sourceId, decisions: records(3), corpus }),
    ).toEqual({ type: "certified", applied: caller.appliedCount(3) });
    const first = await decisionRows(sourceId);
    expect(first).toEqual(settledRows(3));
    expect(landed).toHaveLength(1);

    const again = await caller.apply({
      sourceId,
      decisions: records(3),
      corpus,
    });

    expect(again).toEqual({
      type: "certified",
      applied: caller.appliedCount(0),
    });
    expect(await decisionRows(sourceId)).toEqual(first);
  });

  test("a pack that fails after the rows are written certifies nothing, and a replay settles it", async () => {
    const sourceId = await caller.source();

    const failed = await caller.apply({
      sourceId,
      decisions: records(3),
      corpus: failingTransfer(),
    });

    expect(failed).toEqual({
      type: "held",
      detail: expect.stringContaining(caller.heldFor.pack),
    });
    // The rows were written; only their payloads are unsettled.
    const written = await decisionRows(sourceId);
    expect(written).toHaveLength(3);
    for (const row of written) {
      expect(row.corpusMirrorStatus).toBe(
        CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      );
    }

    const { corpus } = landingTransfer();
    const replayed = await caller.apply({
      sourceId,
      decisions: records(3),
      corpus,
    });

    expect(replayed.type).toBe("certified");
    expect(await decisionRows(sourceId)).toEqual(settledRows(3));
  });

  test("a lease lost while the batch settles certifies nothing, and the next holder's replay converges", async () => {
    const sourceId = await caller.source();
    const { corpus } = landingTransfer(async () => {
      await loseLease(sourceId);
    });

    const lost = await caller.apply({
      sourceId,
      decisions: records(2),
      corpus,
    });

    expect(lost).toEqual({
      type: "held",
      detail: expect.stringContaining(caller.heldFor.lease),
    });
    expect(await sourceCursor(sourceId)).toBeNull();

    const replayed = await caller.apply({
      sourceId,
      decisions: records(2),
      corpus: landingTransfer().corpus,
    });

    expect(replayed.type).toBe("certified");
    expect(await decisionRows(sourceId)).toEqual(settledRows(2));
  });
});

describe("a rejected record whose ledger row cannot be written", () => {
  test("holds the crawl's cursor until a replay records it", async () => {
    const sourceId = await crawlSource();
    const decisions = [record(1), rejectedRecord()];
    const { corpus } = landingTransfer();

    const held = await withUnwritableLedger(
      async () => await crawlCaller.apply({ sourceId, decisions, corpus }),
    );

    expect(held).toEqual({
      type: "held",
      detail: "1 failure record(s) not written; cursor held for retry",
    });
    expect(await ledgerRows(sourceId)).toEqual([]);

    // A rejected record the ledger holds is the crawl's terminal outcome.
    expect(
      (await crawlCaller.apply({ sourceId, decisions, corpus })).type,
    ).toBe("certified");
    expect(await ledgerRows(sourceId)).toEqual([
      { caseNumber: "4 As 99/2008" },
    ]);
    expect(await decisionRows(sourceId)).toEqual(settledRows(1));
  });

  test("earns no receipt when applied directly, and a batch without it settles", async () => {
    const sourceId = await recordSource();
    const decisions = [record(1), rejectedRecord()];
    const { corpus } = landingTransfer();

    const held = await withUnwritableLedger(
      async () => await directCaller.apply({ sourceId, decisions, corpus }),
    );

    expect(held).toEqual({
      type: "held",
      detail: CASE_LAW_BATCH_FAILURE.FAILURE_WRITE,
    });
    expect(await ledgerRows(sourceId)).toEqual([]);

    // Recorded now, and still not a settled record.
    expect(await directCaller.apply({ sourceId, decisions, corpus })).toEqual({
      type: "held",
      detail: CASE_LAW_BATCH_FAILURE.RECORD_REJECTED,
    });
    expect(await ledgerRows(sourceId)).toEqual([
      { caseNumber: "4 As 99/2008" },
    ]);

    expect(
      await directCaller.apply({ sourceId, decisions: [record(1)], corpus }),
    ).toEqual({ type: "certified", applied: 0 });
    expect(await decisionRows(sourceId)).toEqual(settledRows(1));
  });
});

describe("the batch bounds", () => {
  test("a crawl page over the record bound is applied in bounded batches", async () => {
    const sourceId = await crawlSource();
    const { corpus, landed } = landingTransfer();
    const count = CASE_LAW_INGESTION_BATCH_LIMITS.records + 1;

    const applied = await crawlCaller.apply({
      sourceId,
      decisions: records(count),
      corpus,
    });

    expect(applied.type).toBe("certified");
    // One pack per bounded batch: the page did not travel as one.
    expect(landed).toHaveLength(2);
    expect(await decisionRows(sourceId)).toEqual(settledRows(count));
  }, 120_000);

  test("a prepared batch refuses what it cannot carry before any write", () => {
    const { records: maxRecords, encodedBytes } =
      CASE_LAW_INGESTION_BATCH_LIMITS;
    const heavy = (n: number, bytes: number): IngestionResult => ({
      ...record(n),
      fulltext: "a".repeat(bytes),
    });
    const refusal = (decisions: readonly IngestionResult[]) => {
      const prepared = prepareCaseLawIngestionBatch({ decisions });
      return Result.isError(prepared)
        ? { reason: prepared.error.reason, index: prepared.error.index }
        : null;
    };

    expect(refusal([])).toEqual({
      reason: CASE_LAW_BATCH_BOUNDS_REASON.EMPTY,
      index: null,
    });
    expect(refusal(records(maxRecords + 1))).toEqual({
      reason: CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_RECORDS,
      index: null,
    });
    expect(refusal([record(1), heavy(2, encodedBytes)])).toEqual({
      reason: CASE_LAW_BATCH_BOUNDS_REASON.RECORD_TOO_LARGE,
      index: 1,
    });
    expect(
      refusal([heavy(1, encodedBytes / 2), heavy(2, encodedBytes / 2)]),
    ).toEqual({
      reason: CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_BYTES,
      index: null,
    });
    expect(refusal(records(maxRecords))).toBeNull();
  });
});
