import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SyncPage,
  UnreadListedItem,
} from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { UNAVAILABLE_ITEMS_CONFIG_KEY } from "@/api/handlers/case-law/ingestion/pipeline/unread-items";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  isReadRefusal,
  READ_OUTCOME_METADATA_KEY,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
} from "@/api/lib/errors/read-outcome";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import { OBSERVATION_DETAIL } from "@/api/lib/legal-search/partial-observation-sql";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { startFakeS3, type FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// A listed item whose read stays unavailable holds its page for a bounded
// number of consecutive cycles, then the page advances: a stored row keeps
// its detail and gains the typed outcome, a never-stored item is kept as a
// listing-only row with it. A refusal is stored typed at once.

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
let fakeS3: FakeS3;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  fakeS3 = startFakeS3();
}, 120_000);

afterAll(async () => {
  fakeS3.stop();
  await client.close();
});

const originalFetchPage = czNsAdapter.fetchPage;

afterEach(() => {
  czNsAdapter.fetchPage = originalFetchPage;
});

const corpus: CaseLawCorpusDependencies = {
  mode: "canonical",
  transfer: {
    layout: "packs",
    putPacks: async () => await Promise.resolve(Result.ok(undefined)),
  },
};

/** A fresh source under the registered adapter key the tests drive. */
const crawlSource = async (): Promise<SafeId<"caseLawSource">> => {
  await db
    .update(caseLawSources)
    .set({ adapterKey: sql`'retired-' || ${caseLawSources.id}` })
    .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.CZ_NS));
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "unread items fixture",
    syncCursor: "page-1",
  });
  return sourceId;
};

const BASE = {
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2024-01-10",
  decisionType: "usnesení",
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
} as const;

const fullDecision = (id: string): IngestionResult =>
  plainTextIngestionResult({
    ...BASE,
    caseNumber: `21 Cdo ${id}/2024`,
    sourceDocumentId: id,
    fulltext: `Nejvyšší soud rozhodl ve věci ${id}.`,
    metadata: { senate: "21" },
    rawHash: `full-${id}`,
    documentAst: {},
  });

const listingOf = (id: string): UnreadListedItem["listing"] => ({
  ...plainTextIngestionResult({
    ...BASE,
    caseNumber: `21 Cdo ${id}/2024`,
    sourceDocumentId: id,
    isListingOnly: true,
    metadata: { senate: "21" },
    rawHash: `listing-${id}`,
    documentAst: {},
  }),
  sourceDocumentId: id,
  isListingOnly: true,
});

const noContent = (id: string): UnreadListedItem => ({
  listing: listingOf(id),
  outcome: { type: "unavailable", cause: { kind: "no-content", status: 204 } },
});

const emptyServerError = (id: string): UnreadListedItem => ({
  listing: listingOf(id),
  outcome: { type: "unavailable", cause: { kind: "status", status: 500 } },
});

const forbidden = (id: string): UnreadListedItem => ({
  listing: listingOf(id),
  outcome: {
    type: "refused",
    status: 403,
    scope: "document",
    cause: { kind: "http-status", retryAfter: null },
  },
});

/** One crawl cycle over one page; returns where the cursor stands after it. */
const cycle = async (
  sourceId: SafeId<"caseLawSource">,
  page: Omit<SyncPage, "nextCursor">,
) => {
  const sourceLease =
    (await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId })) ??
    panic("expected the source lease to be free");
  czNsAdapter.fetchPage = async () =>
    await Promise.resolve(Result.ok({ ...page, nextCursor: "page-2" }));
  const run = await runIngestionPipeline({
    acquireStoredTotalAdmission: async () => "held",
    source: sourceLease.source,
    sourceLease,
    scopedDb,
    maxPages: 1,
    corpus,
  });
  await sourceLease.release();
  return run;
};

const sourceState = async (sourceId: SafeId<"caseLawSource">) =>
  (
    await db
      .select({
        cursor: caseLawSources.syncCursor,
        config: caseLawSources.config,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, sourceId))
  ).at(0) ?? panic("the source row is gone");

const decisionRow = async (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  (
    await db
      .select()
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
        ),
      )
  ).at(0);

describe("a listed item whose read stays unavailable", () => {
  test("holds its page for the bound, then the page advances with the item kept listing-only", async () => {
    const sourceId = await crawlSource();
    const page = {
      decisions: [fullDecision("ok-1")],
      unreadItems: [noContent("gone-quiet")],
    };

    for (let n = 1; n < UNAVAILABLE_CYCLES_BEFORE_MARKING; n += 1) {
      const held = await cycle(sourceId, page);
      expect(held.haltReason).toContain("unavailable");
      const state = await sourceState(sourceId);
      expect(state.cursor).toBe("page-1");
      expect(state.config?.[UNAVAILABLE_ITEMS_CONFIG_KEY]).toEqual({
        "gone-quiet": n,
      });
      expect(await decisionRow(sourceId, "gone-quiet")).toBeUndefined();
    }

    const advanced = await cycle(sourceId, page);

    expect(advanced.haltReason).toBeNull();
    const state = await sourceState(sourceId);
    expect(state.cursor).toBe("page-2");
    expect(state.config?.[UNAVAILABLE_ITEMS_CONFIG_KEY]).toBeUndefined();
    const stored = await decisionRow(sourceId, "gone-quiet");
    expect(stored?.metadata?.[READ_OUTCOME_METADATA_KEY]).toEqual({
      type: "unavailable",
      scope: "document",
      cause: { kind: "no-content", status: 204 },
      consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
    });
    expect(partialObservationFromMetadata(stored?.metadata).detail).toBe(
      OBSERVATION_DETAIL.LISTING_ONLY,
    );
    expect(stored?.contentHash ?? null).toBeNull();
    expect(await decisionRow(sourceId, "ok-1")).toBeDefined();
  });

  test("a stored row keeps its detail byte for byte and records the outcome", async () => {
    const sourceId = await crawlSource();
    await cycle(sourceId, { decisions: [fullDecision("held-1")] });
    const before = (await decisionRow(sourceId, "held-1")) ?? panic("stored");
    expect(before.contentHash).not.toBeNull();
    await db
      .update(caseLawSources)
      .set({ syncCursor: "page-1" })
      .where(eq(caseLawSources.id, sourceId));

    for (let n = 0; n < UNAVAILABLE_CYCLES_BEFORE_MARKING; n += 1) {
      await cycle(sourceId, {
        decisions: [],
        unreadItems: [emptyServerError("held-1")],
      });
    }

    expect((await sourceState(sourceId)).cursor).toBe("page-2");
    const after = (await decisionRow(sourceId, "held-1")) ?? panic("stored");
    const {
      metadata: metadataAfter,
      sourceObservedAt: _observedAfter,
      sourceObservationOrder: _orderAfter,
      sourceObservationHash: _hashAfter,
      ...detailAfter
    } = after;
    const {
      metadata: metadataBefore,
      sourceObservedAt: _observedBefore,
      sourceObservationOrder: _orderBefore,
      sourceObservationHash: _hashBefore,
      ...detailBefore
    } = before;
    expect(detailAfter).toEqual(detailBefore);
    const { [READ_OUTCOME_METADATA_KEY]: recorded, ...restAfter } =
      metadataAfter ?? {};
    expect(restAfter).toEqual(metadataBefore ?? {});
    expect(recorded).toEqual({
      type: "unavailable",
      scope: "document",
      cause: { kind: "status", status: 500 },
      consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
    });
  });

  test("a later read of unchanged content removes the recorded outcome", async () => {
    const sourceId = await crawlSource();
    await cycle(sourceId, { decisions: [fullDecision("back-1")] });
    for (let n = 0; n < UNAVAILABLE_CYCLES_BEFORE_MARKING; n += 1) {
      await db
        .update(caseLawSources)
        .set({ syncCursor: "page-1" })
        .where(eq(caseLawSources.id, sourceId));
      await cycle(sourceId, {
        decisions: [],
        unreadItems: [emptyServerError("back-1")],
      });
    }
    const marked = (await decisionRow(sourceId, "back-1")) ?? panic("stored");
    expect(marked.metadata?.[READ_OUTCOME_METADATA_KEY]).toBeDefined();
    await db
      .update(caseLawSources)
      .set({ syncCursor: "page-1" })
      .where(eq(caseLawSources.id, sourceId));

    await cycle(sourceId, { decisions: [fullDecision("back-1")] });

    const after = (await decisionRow(sourceId, "back-1")) ?? panic("stored");
    expect(after.sourceHash).toBe(marked.sourceHash);
    const {
      metadata: metadataAfter,
      sourceObservedAt: _observedAfter,
      sourceObservationOrder: _orderAfter,
      sourceObservationHash: _hashAfter,
      ...restAfter
    } = after;
    const {
      metadata: metadataMarked,
      sourceObservedAt: _observedMarked,
      sourceObservationOrder: _orderMarked,
      sourceObservationHash: _hashMarked,
      ...restMarked
    } = marked;
    expect(restAfter).toEqual(restMarked);
    const { [READ_OUTCOME_METADATA_KEY]: _outcome, ...metadataWithout } =
      metadataMarked ?? {};
    expect(metadataAfter ?? {}).toEqual(metadataWithout);
  });

  test("a successful read in between starts the count again", async () => {
    const sourceId = await crawlSource();
    const unread = { decisions: [], unreadItems: [noContent("flaky")] };

    await cycle(sourceId, unread);
    await cycle(sourceId, unread);
    await cycle(sourceId, { decisions: [fullDecision("flaky")] });
    expect((await sourceState(sourceId)).cursor).toBe("page-2");
    await db
      .update(caseLawSources)
      .set({ syncCursor: "page-1" })
      .where(eq(caseLawSources.id, sourceId));
    expect(
      (await sourceState(sourceId)).config?.[UNAVAILABLE_ITEMS_CONFIG_KEY],
    ).toBeUndefined();

    for (let n = 1; n < UNAVAILABLE_CYCLES_BEFORE_MARKING; n += 1) {
      await cycle(sourceId, unread);
      const state = await sourceState(sourceId);
      expect(state.cursor).toBe("page-1");
      expect(state.config?.[UNAVAILABLE_ITEMS_CONFIG_KEY]).toEqual({
        flaky: n,
      });
    }
  });

  test("a page of only unread items writes under the database slot", async () => {
    const sourceId = await crawlSource();
    const sourceLease =
      (await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId })) ??
      panic("expected the source lease to be free");
    czNsAdapter.fetchPage = async () =>
      await Promise.resolve(
        Result.ok({
          decisions: [],
          unreadItems: [forbidden("slotted")],
          nextCursor: "page-2",
        }),
      );
    const slot = { acquired: 0, released: 0 };

    await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source: sourceLease.source,
      sourceLease,
      scopedDb,
      maxPages: 1,
      corpus,
      dbSlot: {
        acquire: async () => {
          slot.acquired += 1;
          await Promise.resolve();
        },
        release: () => {
          slot.released += 1;
        },
      },
    });
    await sourceLease.release();

    expect(slot).toEqual({ acquired: 1, released: 1 });
    expect(await decisionRow(sourceId, "slotted")).toBeDefined();
  });

  test("a refusal is stored typed at once and holds nothing", async () => {
    const sourceId = await crawlSource();

    const run = await cycle(sourceId, {
      decisions: [],
      unreadItems: [forbidden("withheld")],
    });

    expect(run.haltReason).toBeNull();
    const state = await sourceState(sourceId);
    expect(state.cursor).toBe("page-2");
    expect(state.config?.[UNAVAILABLE_ITEMS_CONFIG_KEY]).toBeUndefined();
    const stored = await decisionRow(sourceId, "withheld");
    expect(isReadRefusal(stored?.metadata?.[READ_OUTCOME_METADATA_KEY])).toBe(
      true,
    );
    expect(stored?.metadata?.[READ_OUTCOME_METADATA_KEY]).toMatchObject({
      status: 403,
      scope: "document",
    });
  });
});
