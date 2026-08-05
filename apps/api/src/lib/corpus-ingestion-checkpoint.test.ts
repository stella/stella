import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  legislationSources,
  relations,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const caseLawSourceId = createSafeId<"caseLawSource">();
const lifecycleSourceId = createSafeId<"caseLawSource">();
const legislationSourceId = createSafeId<"legislationSource">();
const ingestionLeaseToken = createSafeId<"caseLawSourceIngestionLease">();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });

    await db.insert(caseLawSources).values({
      id: caseLawSourceId,
      adapterKey: "checkpoint-case-law",
      name: "Checkpoint case-law source",
    });
    await db.insert(caseLawSources).values({
      id: lifecycleSourceId,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "Lifecycle case-law source",
    });
    await db.insert(legislationSources).values({
      id: legislationSourceId,
      adapterKey: "checkpoint-legislation",
      name: "Checkpoint legislation source",
    });

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- pglite test transaction is structurally compatible with the production transaction used by ScopedDb
    scopedDb = (async (callback: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(
        // oxlint-disable-next-line node/callback-return -- the expression body returns the awaited callback result
        async (tx) => await callback(tx),
      )) as unknown as ScopedDb;
  },
  { timeout: 30_000 },
);

beforeEach(async () => {
  await db
    .update(caseLawSources)
    .set({
      syncCursor: null,
      observationOrder: 1n,
      checkpointObservationOrder: 0n,
      ingestionLeaseToken,
      ingestionLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    .where(eq(caseLawSources.id, caseLawSourceId));
  await db
    .update(caseLawSources)
    .set({
      syncCursor: null,
      observationOrder: 0n,
      checkpointObservationOrder: 0n,
      ingestionLeaseToken: null,
      ingestionLeaseExpiresAt: null,
    })
    .where(eq(caseLawSources.id, lifecycleSourceId));
  await db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, lifecycleSourceId));
  await db
    .update(legislationSources)
    .set({ syncCursor: null })
    .where(eq(legislationSources.id, legislationSourceId));
});

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

describe("advanceCorpusIngestionCheckpoint", () => {
  test("advances both supported corpus source types", async () => {
    const caseLaw = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "case-page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });
    const legislation = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "legislation-page-2",
      scopedDb,
      source: {
        id: legislationSourceId,
        type: CORPUS_SOURCE_TYPE.LEGISLATION,
      },
    });

    expect(caseLaw).toEqual({
      cursor: "case-page-2",
      status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
    });
    expect(
      (
        await db
          .select({
            order: caseLawSources.checkpointObservationOrder,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, caseLawSourceId))
          .limit(1)
      ).at(0)?.order,
    ).toBe(1n);
    expect(legislation).toEqual({
      cursor: "legislation-page-2",
      status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
    });
  });

  test("recognizes an exact checkpoint replay", async () => {
    const transition = {
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    };

    await advanceCorpusIngestionCheckpoint(transition);
    const replay = await advanceCorpusIngestionCheckpoint(transition);

    expect(replay).toEqual({
      cursor: "page-2",
      status: INGESTION_CHECKPOINT_STATUS.ALREADY_CURRENT,
    });
  });

  test("allows only one divergent writer from the same cursor", async () => {
    const transitions = await Promise.all([
      advanceCorpusIngestionCheckpoint({
        expectedCursor: null,
        nextCursor: "winner-a",
        scopedDb,
        source: {
          id: caseLawSourceId,
          leaseToken: ingestionLeaseToken,
          observationOrder: 1n,
          type: CORPUS_SOURCE_TYPE.CASE_LAW,
        },
      }),
      advanceCorpusIngestionCheckpoint({
        expectedCursor: null,
        nextCursor: "winner-b",
        scopedDb,
        source: {
          id: caseLawSourceId,
          leaseToken: ingestionLeaseToken,
          observationOrder: 1n,
          type: CORPUS_SOURCE_TYPE.CASE_LAW,
        },
      }),
    ]);
    const [stored] = await db
      .select({ cursor: caseLawSources.syncCursor })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, caseLawSourceId));
    if (!stored) {
      throw new Error("checkpoint source unexpectedly missing");
    }

    expect(
      transitions.filter(
        ({ status }) => status === INGESTION_CHECKPOINT_STATUS.ADVANCED,
      ),
    ).toHaveLength(1);
    for (const result of transitions) {
      if (result.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
        throw new Error("checkpoint source unexpectedly missing");
      }
      expect(result.cursor).toBe(stored.cursor);
    }
  });

  test("does not let a stale writer move the cursor backward", async () => {
    await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-3",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    const stale = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    expect(stale).toEqual({
      cursor: "page-3",
      status: INGESTION_CHECKPOINT_STATUS.SUPERSEDED,
    });
  });

  test("holds a cursor behind the greatest observation token", async () => {
    await db
      .update(caseLawSources)
      .set({
        syncCursor: "page-3",
        observationOrder: 3n,
        checkpointObservationOrder: 3n,
      })
      .where(eq(caseLawSources.id, caseLawSourceId));

    const delayedHold = await advanceCorpusIngestionCheckpoint({
      expectedCursor: "page-3",
      nextCursor: "page-3",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });
    const delayedAdvance = await advanceCorpusIngestionCheckpoint({
      expectedCursor: "page-3",
      nextCursor: "page-4",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 2n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });
    const currentAdvance = await advanceCorpusIngestionCheckpoint({
      expectedCursor: "page-3",
      nextCursor: "page-4",
      scopedDb,
      source: {
        id: caseLawSourceId,
        leaseToken: ingestionLeaseToken,
        observationOrder: 3n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    expect(delayedHold.status).toBe(
      INGESTION_CHECKPOINT_STATUS.ALREADY_CURRENT,
    );
    expect(delayedAdvance.status).toBe(INGESTION_CHECKPOINT_STATUS.SUPERSEDED);
    expect(currentAdvance.status).toBe(INGESTION_CHECKPOINT_STATUS.ADVANCED);
    expect(
      (
        await db
          .select({
            cursor: caseLawSources.syncCursor,
            order: caseLawSources.checkpointObservationOrder,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, caseLawSourceId))
          .limit(1)
      ).at(0),
    ).toEqual({ cursor: "page-4", order: 3n });
  });

  test("reports a missing source", async () => {
    const result = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: createSafeId<"caseLawSource">(),
        leaseToken: ingestionLeaseToken,
        observationOrder: 1n,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    expect(result).toEqual({
      status: INGESTION_CHECKPOINT_STATUS.MISSING,
    });
  });
});

describe("case-law source ingestion lease", () => {
  test("admits one fetch owner and reloads the cursor after handoff", async () => {
    await db
      .update(caseLawSources)
      .set({ ingestionLeaseToken: null, ingestionLeaseExpiresAt: null })
      .where(eq(caseLawSources.id, caseLawSourceId));

    const first = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: caseLawSourceId,
    });
    if (!first) {
      throw new Error("first source lease was not acquired");
    }

    const overlapping = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: caseLawSourceId,
    });
    expect(overlapping).toBeNull();

    await db
      .update(caseLawSources)
      .set({ syncCursor: "page-after-first-owner" })
      .where(eq(caseLawSources.id, caseLawSourceId));
    await first.release();

    const replacement = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: caseLawSourceId,
    });
    expect(replacement?.source.syncCursor).toBe("page-after-first-owner");
    await replacement?.release();
  });

  test("owns one complete fetch-to-checkpoint lifecycle", async () => {
    const originalFetchPage = czNsAdapter.fetchPage;
    czNsAdapter.fetchPage = async (cursor) => {
      expect(cursor).toBeNull();
      return Result.ok({
        decisions: [
          {
            caseNumber: "lifecycle/1/2026",
            sourceDocumentId: "lifecycle-document-1",
            court: "Lifecycle Court",
            country: "CZE",
            language: "cs",
            fulltext: "Lifecycle decision text.",
            metadata: {},
            rawHash: "lifecycle-hash-1",
            documentAst: EMPTY_AST,
          },
        ],
        nextCursor: "lifecycle-page-2",
      });
    };

    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: lifecycleSourceId,
    });
    if (!lease) {
      throw new Error("lifecycle source lease was not acquired");
    }

    try {
      const result = await runIngestionPipeline({
        maxPages: 1,
        scopedDb,
        source: lease.source,
        sourceLease: lease,
      });
      expect(result).toMatchObject({
        inserted: 1,
        nextCursor: "lifecycle-page-2",
        pagesProcessed: 1,
      });
    } finally {
      czNsAdapter.fetchPage = originalFetchPage;
      await lease.release();
    }

    expect(
      (
        await db
          .select({
            checkpointOrder: caseLawSources.checkpointObservationOrder,
            cursor: caseLawSources.syncCursor,
            leaseToken: caseLawSources.ingestionLeaseToken,
            observationOrder: caseLawSources.observationOrder,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, lifecycleSourceId))
          .limit(1)
      ).at(0),
    ).toEqual({
      checkpointOrder: 1n,
      cursor: "lifecycle-page-2",
      leaseToken: null,
      observationOrder: 1n,
    });
    expect(
      await db
        .select({
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, lifecycleSourceId)),
    ).toEqual([
      {
        sourceDocumentId: "lifecycle-document-1",
        sourceObservationOrder: 1n,
      },
    ]);
  });
});
