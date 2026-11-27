import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { deferred, settledWithin } from "@stll/test-kit";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { CORPUS_PROJECTION_APPEND_COMMIT_MODE } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { CORPUS_PROJECTION_GENERATION_SCOPE } from "@/api/lib/legal-search/corpus-index-projection-scope";
import { CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT } from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { logger } from "@/api/lib/observability/logger";
import { optOutOfCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const LEGISLATION_TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const LEGISLATION_MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000f1";
const EPOCH = 7n;
const documentId = (index: number): string =>
  `0198e331-e578-7000-8000-0000000004${String(index).padStart(2, "0")}`;

const seedLegislation = async (indexes: readonly number[]) => {
  const rows = indexes.map((index) => ({
    id: toSafeId<"legislationDocument">(documentId(index)),
    sourceId: toSafeId<"legislationSource">(SOURCE_ID),
    eli: `eli/cz/sb/2015/${100 + index}`,
    title: `Act ${100 + index}`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    effectiveDate: "2015-01-01",
    versionValidFrom: "2015-01-01",
    versionValidTo: null,
    contentHash: "a".repeat(64),
    textS3Key: `test-corpus/${index}`,
    projectionEpoch: EPOCH,
  }));
  await db.insert(legislationDocuments).values(rows);
  await db.insert(corpusIndexProjectionStates).values(
    rows.map((row) => {
      const descriptor = deriveCorpusIndexProjectionDescriptor(
        LEGISLATION_MANIFEST,
        legislationProjectionInputFromCanonical({
          documentId: row.id,
          sourceId: row.sourceId,
          jurisdiction: row.country,
          language: row.language,
          documentType: row.documentType,
          contentHash: row.contentHash,
          title: row.title,
          status: row.status,
          effectiveDate: row.effectiveDate,
          versionValidFrom: row.versionValidFrom,
          versionValidTo: row.versionValidTo,
          eli: row.eli,
          sourceDescriptor: null,
          ...EFFECTIVE_CONSOLIDATION,
        }),
      );
      if (descriptor.action !== "upsert") {
        return panic("Seeded legislation row is not projectable");
      }
      return {
        ...LEGISLATION_TARGET,
        entityId: String(row.id),
        desiredAction: "upsert" as const,
        desiredEpoch: EPOCH,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => id);
};

const projectionStates = async (entityIds: readonly string[]) =>
  await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      workStatus: corpusIndexProjectionStates.workStatus,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
      appendRequestCap: corpusIndexProjectionStates.appendRequestCap,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(
          corpusIndexProjectionStates.generation,
          LEGISLATION_TARGET.generation,
        ),
        inArray(corpusIndexProjectionStates.entityId, [...entityIds]),
      ),
    )
    .orderBy(corpusIndexProjectionStates.entityId);

const reservedIntents = async (entityIds: readonly string[]) =>
  (
    await db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
          eq(corpusIndexProjectionIntents.status, "reserved"),
        ),
      )
  ).length;

const runLegislationCycle = async ({
  entityIds,
  text,
  ingest,
  presence = "complete",
  commitMode = CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
}: {
  entityIds: readonly SafeId<"legislationDocument">[];
  text: string;
  ingest: (
    indexId: string,
    ndjson: string,
  ) => Promise<Result<void, CorpusIndexError>>;
  presence?: "complete" | "missing" | "partial" | "unavailable";
  commitMode?: (typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE)[keyof typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE];
}) => {
  const publishedCounts = new Map<string, number>();
  return await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestCommittedBatch: async ({ indexId, ndjson }) => {
        const result = await ingest(indexId, ndjson);
        if (result.isErr() || presence === "missing") {
          return result;
        }
        for (const line of ndjson.split("\n")) {
          const { projection_revision } = JSON.parse(line);
          if (typeof projection_revision !== "string") {
            panic("Published document has no revision");
          }
          publishedCounts.set(
            projection_revision,
            (publishedCounts.get(projection_revision) ?? 0) + 1,
          );
        }
        return result;
      },
      ingestQueuedBatch: async () =>
        panic("Projection append must wait for publication"),
      aggregate: async ({ query }) => {
        if (presence === "unavailable") {
          return Result.err(
            new CorpusIndexError({
              message: "search unavailable",
              status: 503,
            }),
          );
        }
        return Result.ok({
          projection_revisions: {
            buckets: Array.from(publishedCounts, ([key, count]) => ({
              key,
              doc_count: presence === "partial" ? count - 1 : count,
            })).filter(
              ({ key, doc_count }) =>
                query.includes(`"${key}"`) && doc_count > 0,
            ),
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        });
      },
    },
    commitMode,
    ...LEGISLATION_TARGET,
    scope: { type: "subjects", entityIds },
    limit: entityIds.length,
    fillWindowMs: 600_000,
    payloadReadConcurrency: 2,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    proofAfterIndexId: null,
    payloadReader: async () =>
      Result.ok({ text, ast: null, storedAst: { type: "absent" } as const }),
  });
};

const makeRetryDue = async (entityIds: readonly string[]) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1937007986, 1)`);
    await tx
      .update(corpusIndexGenerations)
      .set({ status: "retiring" })
      .where(
        eq(corpusIndexGenerations.generation, LEGISLATION_TARGET.generation),
      );
    await tx
      .delete(corpusIndexProjectionIntents)
      .where(inArray(corpusIndexProjectionIntents.entityId, [...entityIds]));
    await tx
      .update(corpusIndexGenerations)
      .set({ status: "building" })
      .where(
        eq(corpusIndexGenerations.generation, LEGISLATION_TARGET.generation),
      );
  });
  await db
    .update(corpusIndexProjectionStates)
    .set({ retryNotBefore: new Date(0) })
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

const unusedIngest = async () =>
  panic("An idle projection cycle must not reach the engine");

const runCycle = async (
  commitMode: (typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE)[keyof typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE],
) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestCommittedBatch: unusedIngest,
      ingestQueuedBatch: unusedIngest,
      aggregate: unusedIngest,
    },
    commitMode,
    family: TARGET.family,
    generation: TARGET.generation,
    scope: CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: 8,
    fillWindowMs: 60_000,
    payloadReadConcurrency: 4,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    proofAfterIndexId: null,
  });

beforeAll(async () => {
  client = await createTestPglite();
  await optOutOfCorpusProjectionSeedingGuard(client, {
    reason:
      "Exercises the projection store, executor and serving pipeline on canonical rows and desired states this suite stands up as fixtures; no desired writer runs here, and the writer suites keep the guard.",
  });
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await db.insert(corpusIndexGenerations).values({
    ...LEGISLATION_TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(LEGISLATION_MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: toSafeId<"legislationSource">(SOURCE_ID),
    adapterKey: "projection-test",
    name: "Projection test",
    descriptor: null,
  });
});

afterAll(async () => {
  await client.close();
});

test("every cycle reports one timing per phase, in both commit modes", async () => {
  for (const commitMode of Object.values(
    CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  )) {
    const result = await runCycle(commitMode);

    expect(result.status).toBe("idle");
    expect(result.requestCount).toBe(0);
    // The caller logs these, so a phase that stops being measured has to
    // fail here rather than quietly report zero forever.
    expect(result.timing).toEqual({
      reservationMs: expect.any(Number),
      materialReadMs: 0,
      payloadLoadMs: 0,
      documentBuildMs: 0,
      ingestMs: 0,
      storeCommitMs: 0,
    });
    expect(result.timing.reservationMs).toBeGreaterThanOrEqual(0);
  }
});

/**
 * Resolves once `count` arrivals have called `arrive`; a chain that sends its
 * requests one after another never gets there, so the wait fails instead of
 * hanging the suite.
 */
const arrivals = (count: number) => {
  let arrived = 0;
  const all = deferred();
  return {
    arrive: async (): Promise<void> => {
      arrived += 1;
      if (arrived >= count) {
        all.resolve();
      }
      await settledWithin(all.promise, {
        description: `${count} requests in flight together`,
      });
    },
  };
};

test("repeated 413 cycles park only the rejected revision after its healthy batch mate succeeds", async () => {
  const entityIds = await seedLegislation([1, 2]);
  const failingEntity =
    entityIds.at(0) ?? panic("Expected failing legislation entity");
  const healthyEntity =
    entityIds.at(1) ?? panic("Expected healthy legislation entity");
  const requestSizes: number[] = [];
  const warn = spyOn(logger, "warn");
  let pair = arrivals(1);
  const ingest = async (_indexId: string, ndjson: string) => {
    const size = ndjson.split("\n").length;
    requestSizes.push(size);
    // Both halves of a split request are in flight together.
    await pair.arrive();
    if (ndjson.includes(failingEntity)) {
      return Result.err(
        new CorpusIndexError({
          message: "request rejected",
          status: 413,
          rejection: "definite",
        }),
      );
    }
    return Result.ok(undefined);
  };
  try {
    const first = await runLegislationCycle({
      entityIds,
      text: "Small act text.",
      ingest,
    });
    expect(first.status).toBe("append_unknown");
    expect(first.requestCount).toBe(1);
    expect(requestSizes).toEqual([2]);
    // The rejected request halves its revisions' caps, uncharged.
    expect(await projectionStates(entityIds)).toEqual(
      entityIds.map((entityId) => ({
        entityId,
        workStatus: "retry_scheduled",
        failureAttempts: 0,
        lastFailureKind: "append_rejected",
        appendRequestCap: 1,
      })),
    );

    await makeRetryDue(entityIds);
    pair = arrivals(2);
    const second = await runLegislationCycle({
      entityIds,
      text: "Small act text.",
      ingest,
    });
    // The rejected half stops new starts, not the half already in flight.
    expect(second.status).toBe("append_unknown");
    expect(second.requestCount).toBe(2);
    expect(second.applied).toBe(1);
    expect(second.cancelled).toBe(0);
    expect(requestSizes).toEqual([2, 1, 1]);
    expect(await projectionStates(entityIds)).toEqual([
      {
        entityId: failingEntity,
        workStatus: "retry_scheduled",
        failureAttempts: 1,
        lastFailureKind: "append_rejected",
        appendRequestCap: 1,
      },
      {
        entityId: healthyEntity,
        workStatus: "eligible",
        failureAttempts: 0,
        lastFailureKind: null,
        appendRequestCap: 512,
      },
    ]);

    await makeRetryDue([failingEntity]);
    pair = arrivals(1);
    const third = await runLegislationCycle({
      entityIds,
      text: "Small act text.",
      ingest,
    });
    expect(third.status).toBe("append_blocked");
    expect(third.blocked).toBe(1);
    expect(third.requestCount).toBe(1);
    expect(requestSizes).toEqual([2, 1, 1, 1]);
    expect(await projectionStates(entityIds)).toEqual([
      {
        entityId: failingEntity,
        workStatus: "blocked",
        failureAttempts: 2,
        lastFailureKind: "append_rejected",
        appendRequestCap: 1,
      },
      {
        entityId: healthyEntity,
        workStatus: "eligible",
        failureAttempts: 0,
        lastFailureKind: null,
        appendRequestCap: 512,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "corpus_projection.append_blocked",
      expect.objectContaining({
        entity: failingEntity,
        kind: "append_rejected",
        attempts: 2,
      }),
    );
  } finally {
    warn.mockRestore();
  }
});

test("a persistent 500 on one revision is charged until it parks", async () => {
  const entityIds = await seedLegislation([11]);
  const ingest = async () =>
    Result.err(new CorpusIndexError({ message: "ingest failed", status: 500 }));

  for (
    let attempt = 1;
    attempt <= CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT;
    attempt += 1
  ) {
    if (attempt > 1) {
      await makeRetryDue(entityIds);
    }
    const result = await runLegislationCycle({
      entityIds,
      text: "Small act text.",
      ingest,
    });
    const parked = attempt === CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT;
    expect(result.status).toBe(parked ? "append_blocked" : "append_unknown");
    expect(result.requestCount).toBe(1);
    expect(result.blocked).toBe(parked ? 1 : 0);
    expect(await projectionStates(entityIds)).toEqual([
      {
        entityId:
          entityIds.at(0) ?? panic("Expected seeded legislation entity"),
        workStatus: parked ? "blocked" : "retry_scheduled",
        failureAttempts: attempt,
        lastFailureKind: "append_unknown",
        appendRequestCap: 512,
      },
    ]);
  }
});

test("an unknown two-revision outcome does not charge either batch mate", async () => {
  const entityIds = await seedLegislation([7, 8]);
  const requestSizes: number[] = [];
  const ingest = async (_indexId: string, ndjson: string) => {
    requestSizes.push(ndjson.split("\n").length);
    return Result.err(new CorpusIndexError({ message: "partial receipt" }));
  };
  const first = await runLegislationCycle({
    entityIds,
    text: "Small act text.",
    ingest,
  });
  expect(first.status).toBe("append_unknown");
  expect(requestSizes).toEqual([2]);
  expect(
    (await projectionStates(entityIds)).map(
      ({ failureAttempts, appendRequestCap }) => ({
        failureAttempts,
        appendRequestCap,
      }),
    ),
  ).toEqual([
    { failureAttempts: 0, appendRequestCap: 1 },
    { failureAttempts: 0, appendRequestCap: 1 },
  ]);

  await makeRetryDue(entityIds);
  const second = await runLegislationCycle({
    entityIds,
    text: "Small act text.",
    ingest,
  });
  // Each revision is now alone, so each unknown outcome is its own and is
  // charged; whichever request failed first, neither revision is left
  // reserved, and none is charged twice.
  expect(second.requestCount + second.cancelled).toBe(2);
  expect(requestSizes.slice(0, 1)).toEqual([2]);
  expect(requestSizes.slice(1).every((size) => size === 1)).toBe(true);
  const charged = (await projectionStates(entityIds)).map(
    ({ failureAttempts }) => failureAttempts,
  );
  expect(charged.toSorted((left, right) => left - right)).toEqual(
    second.requestCount === 2 ? [1, 1] : [0, 1],
  );
  expect(await reservedIntents(entityIds)).toBe(0);
});

test.each([
  ["404", 3, { status: 404 }],
  ["503", 4, { status: 503 }],
  ["connection", 5, { cause: new Error("connection unavailable") }],
] as const)(
  "an engine %s stops the cycle without charging a revision",
  async (_kind, index, errorOptions) => {
    const entityIds = await seedLegislation([index]);
    const result = await runLegislationCycle({
      entityIds,
      text: "Small act text.",
      ingest: async () =>
        Result.err(
          new CorpusIndexError({
            message: "engine unavailable",
            ...errorOptions,
          }),
        ),
    });
    expect(result.status).toBe("engine_unavailable");
    expect(result.cycleRetryDelayMs).toBeGreaterThan(0);
    expect(result.requestCount).toBe(1);
    expect(await projectionStates(entityIds)).toEqual([
      {
        entityId:
          entityIds.at(0) ?? panic("Expected seeded legislation entity"),
        workStatus: "retry_scheduled",
        failureAttempts: 0,
        lastFailureKind: "append_unknown",
        appendRequestCap: 512,
      },
    ]);
  },
);

test("an engine fault starts nothing more and hands back what it did not start", async () => {
  const entityIds = await seedLegislation([9, 10]);
  const result = await runLegislationCycle({
    entityIds,
    text: "A".repeat(5 * 1024 * 1024),
    ingest: async () =>
      Result.err(
        new CorpusIndexError({ message: "index unavailable", status: 404 }),
      ),
  });
  expect(result.status).toBe("engine_unavailable");
  // A request already in flight when the first failed still records its
  // outcome; one not started by then is handed back, not left to expire.
  expect(result.requestCount + result.cancelled).toBe(2);
  expect(result.requestCount).toBeGreaterThanOrEqual(1);
  expect(await reservedIntents(entityIds)).toBe(0);
  expect(
    (await projectionStates(entityIds)).map(
      ({ failureAttempts }) => failureAttempts,
    ),
  ).toEqual([0, 0]);
});

test("an act above the absolute ceiling parks with a counted outcome and an event", async () => {
  const entityIds = await seedLegislation([6]);
  const warn = spyOn(logger, "warn");
  const text = "A".repeat(129 * 1024 * 1024);
  try {
    const result = await runLegislationCycle({
      entityIds,
      text,
      ingest: async () => panic("An over-cap revision must not reach ingest"),
    });
    expect(result.status).toBe("append_blocked");
    expect(result.blocked).toBe(1);
    expect(result.requestCount).toBe(0);
    const [state] = await projectionStates(entityIds);
    expect(state?.workStatus).toBe("blocked");
    expect(state?.failureAttempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "corpus_projection.append_blocked",
      expect.objectContaining({
        entity: entityIds.at(0) ?? panic("Expected seeded legislation entity"),
        kind: "revision_too_large",
        attempts: 1,
      }),
    );
  } finally {
    warn.mockRestore();
  }
}, 120_000);

test.each([
  ["missing", 80],
  ["partial", 82],
  ["unavailable", 84],
] as const)(
  "ingest OK with %s publication never records applied progress",
  async (presence, index) => {
    const entityIds = await seedLegislation([index, index + 1]);
    let accepted = 0;
    const result = await runLegislationCycle({
      entityIds,
      text: "An act with searchable passages.\n\n".repeat(200),
      ingest: async () => {
        accepted += 1;
        return Result.ok(undefined);
      },
      presence,
      commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued,
    });
    expect(accepted).toBeGreaterThan(0);
    expect(result.status).toBe("engine_unavailable");
    expect(result.applied).toBe(0);
    expect(result.unknownCleanupPending).toBe(2);
    const states = await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(inArray(corpusIndexProjectionStates.entityId, entityIds));
    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state.appliedAction).toBeNull();
      expect(state.appliedEpoch).toBeNull();
      expect(state.appliedRevision).toBeNull();
      expect(state.appliedFingerprint).toBeNull();
      expect(state.appliedIndexId).toBeNull();
      expect(state.appliedAt).toBeNull();
    }
    const intents = await db
      .select()
      .from(corpusIndexProjectionIntents)
      .where(inArray(corpusIndexProjectionIntents.entityId, entityIds));
    expect(intents).toHaveLength(2);
    expect(intents.every(({ status }) => status === "cleanup_pending")).toBe(
      true,
    );
  },
);

test("a serving generation waits for publication and confirms the whole batch even in queued catch-up", async () => {
  const entityIds = await seedLegislation([90, 91]);
  await db
    .update(corpusIndexGenerations)
    .set({ status: "serving" })
    .where(
      eq(corpusIndexGenerations.generation, LEGISLATION_TARGET.generation),
    );
  try {
    const result = await runLegislationCycle({
      entityIds,
      text: "A published act.",
      ingest: async () => Result.ok(undefined),
      commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued,
    });
    expect(result.status).toBe("completed");
    expect(result.applied).toBe(2);
    const states = await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(inArray(corpusIndexProjectionStates.entityId, entityIds));
    expect(states).toHaveLength(2);
    expect(
      states.every(
        ({ appliedAction, appliedRevision }) =>
          appliedAction === "upsert" && appliedRevision !== null,
      ),
    ).toBe(true);
  } finally {
    await db
      .update(corpusIndexGenerations)
      .set({ status: "building" })
      .where(
        eq(corpusIndexGenerations.generation, LEGISLATION_TARGET.generation),
      );
  }
});
