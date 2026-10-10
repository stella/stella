import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { initialBatchState } from "@stll/db-load-gate/health";

import {
  BackfillFailedError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  databaseBackfillStates,
  legislationDocuments,
  legislationSources,
  schedulerJobs,
  schedulerJobRuns,
} from "@/api/db/schema";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import { logger } from "@/api/lib/observability/logger";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { runJob } from "@/api/lib/scheduler/runner";
import {
  BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
  createLegislationExpressionIdBackfill,
} from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000a01",
);
const UNNAMESPACED_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000a02",
);
const JOB_ID = "test.legislation-expression-id-backfill";
const LEASE = "test-lease";

/** Ids in insertion order, so the keyset walk's order is the fixture's. */
const documentId = (n: number) =>
  toSafeId<"legislationDocument">(
    `0198e331-e578-7000-8000-${n.toString(16).padStart(12, "0")}`,
  );

const iri = (n: number) =>
  `https://example.test/eli/cz/sb/2000/${n}/2020-01-01`;

type ExpressionBackfillCasesOptions = {
  openDatabase: () => Promise<GatedTestDb>;
  createRuntime?: typeof createScriptBackfillRuntime;
  engine: "pglite" | "postgres";
};

export const registerExpressionBackfillCases = ({
  openDatabase,
  createRuntime = createScriptBackfillRuntime,
  engine,
}: ExpressionBackfillCasesOptions) => {
  let db: GatedTestDb;
  let continuationAt: Date | undefined;

  /** One scheduled run; true when it asked to be followed at once. */
  const run = async (
    task: SchedulerTask,
    taskLogger: typeof logger = logger,
  ) => {
    const job = (
      await db.select().from(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID))
    ).at(0);
    if (!job) {
      return panic("expected the scheduler job");
    }
    const continuation = { requested: false };
    continuationAt = undefined;
    const outcome = await task({
      db: asTestRaw<SchedulerDb>(db),
      job,
      payload: job.payload,
      dueAt: DueSlot.of(job),

      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: (at) => {
        continuationAt = at;
        continuation.requested = true;
      },
      signal: new AbortController().signal,
      logger: taskLogger,
    });
    return outcome?.isErr() ? outcome : continuation.requested;
  };

  /**
   * Runs until the task stops asking to continue: the rest of the current pass.
   * Bounded, so a task that never stops fails here instead of hanging.
   */
  const runPass = async (
    task: SchedulerTask = createTask(),
    taskLogger: typeof logger = logger,
  ): Promise<number> => {
    for (let runs = 1; runs <= 100; runs += 1) {
      const outcome = await run(task, taskLogger);
      if (typeof outcome !== "boolean") {
        return panic("expression backfill pass failed");
      }
      if (!outcome) {
        return runs;
      }
    }
    return panic("the backfill never finished its pass");
  };

  type LogLine = { message: string; attributes: Record<string, unknown> };

  /** A logger that keeps what the task says, for the test to read. */
  const recordingLogger = () => {
    const lines: LogLine[] = [];
    const record = (
      message: string,
      attributes: Record<string, unknown> = {},
    ) => {
      lines.push({ message, attributes });
    };
    return {
      lines,
      logger: { ...logger, info: record, warn: record } satisfies typeof logger,
    };
  };

  const cursor = async (): Promise<unknown> =>
    (
      await db
        .select({ cursor: databaseBackfillStates.cursor })
        .from(databaseBackfillStates)
        .where(
          eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.expressionIds),
        )
    ).at(0)?.cursor;

  const idsOf = async (ids: readonly SafeId<"legislationDocument">[]) =>
    (
      await db
        .select({
          id: legislationDocuments.id,
          publisherId: legislationDocuments.publisherExpressionId,
        })
        .from(legislationDocuments)
        .where(inArray(legislationDocuments.id, [...ids]))
        .orderBy(asc(legislationDocuments.id))
    ).map(({ publisherId }) => publisherId);

  type LegacyRowOptions = {
    metadata?: Record<string, unknown>;
    sourceId?: SafeId<"legislationSource">;
  };

  const insertLegacy = async (
    n: number,
    {
      metadata = { versionIri: iri(n) },
      sourceId = SOURCE_ID,
    }: LegacyRowOptions = {},
  ) => {
    await db.insert(legislationDocuments).values({
      id: documentId(n),
      sourceId,
      eli: `eli/cz/sb/2000/${n}`,
      title: `Act 2000/${n}`,
      country: "CZE",
      language: "cs",
      versionValidFrom: "2020-01-01",
      metadata,
    });
  };

  const createTask = (
    options: Parameters<typeof createLegislationExpressionIdBackfill>[0] = {},
  ) =>
    createLegislationExpressionIdBackfill({
      readVerdict: async () =>
        await Promise.resolve({ kind: "normal", signals: [] }),
      observeStatus: () => undefined,
      createRuntime,
      ...options,
    });

  beforeAll(async () => {
    db = await openDatabase();
    await db.insert(legislationSources).values([
      {
        id: SOURCE_ID,
        adapterKey: "expression-backfill-test",
        name: "Expression backfill test",
        expressionNamespace: "esel",
      },
      {
        id: UNNAMESPACED_SOURCE_ID,
        adapterKey: "expression-backfill-unnamespaced",
        name: "Source with no namespace yet",
      },
    ]);
    await db.insert(schedulerJobs).values({
      description: "legislation expression id backfill test",
      id: JOB_ID,
      lockedBy: LEASE,
      nextRunAt: new Date("2026-09-28T00:00:00.000Z"),
      schedule: { type: "interval", everyMs: 60_000 },
      task: BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
    });
  });

  describe("legislation expression id backfill", () => {
    test("claims in checkpointed pages, resumes from the cursor, and reaches a fixed point", async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        await insertLegacy(n);
      }
      // Left alone: no IRI to prove an id, and a source with no namespace.
      await insertLegacy(6, { metadata: {} });
      await insertLegacy(7, { sourceId: UNNAMESPACED_SOURCE_ID });
      const ids = [1, 2, 3, 4, 5, 6, 7].map(documentId);

      const twoRowPages = createTask({ pageRows: 2 });

      // A page that leaves rows behind it asks for the next run at once.
      expect(await run(twoRowPages)).toBe(true);
      expect(await cursor()).toBe(documentId(2));
      expect(await idsOf(ids)).toEqual([
        `esel:${iri(1)}`,
        `esel:${iri(2)}`,
        null,
        null,
        null,
        null,
        null,
      ]);

      // The next run resumes after the committed cursor, not from the start.
      await run(twoRowPages);
      expect(await cursor()).toBe(documentId(4));

      // Pages 5-6 and 7, then the end of the table, which asks for nothing more.
      expect(await runPass(twoRowPages)).toBe(3);
      expect(await cursor()).toBeNull();
      const claimed = [
        `esel:${iri(1)}`,
        `esel:${iri(2)}`,
        `esel:${iri(3)}`,
        `esel:${iri(4)}`,
        `esel:${iri(5)}`,
        null,
        null,
      ];
      expect(await idsOf(ids)).toEqual(claimed);

      // A second full pass changes nothing.
      await runPass(twoRowPages);
      expect(await idsOf(ids)).toEqual(claimed);
    });

    test("a row stored after a pass is claimed by the next one, and nothing else about it changes", async () => {
      await insertLegacy(8);
      const unchanged = async () =>
        await db
          .select({
            updatedAt: legislationDocuments.updatedAt,
            payloadRevision: legislationDocuments.payloadRevision,
          })
          .from(legislationDocuments)
          .where(eq(legislationDocuments.id, documentId(8)));
      const before = await unchanged();

      await runPass();

      expect(await idsOf([documentId(8)])).toEqual([`esel:${iri(8)}`]);
      expect(await unchanged()).toEqual(before);
    });

    test("an id another row of the work already carries is not given twice", async () => {
      await insertLegacy(9);
      await db
        .update(legislationDocuments)
        .set({ publisherExpressionId: `esel:${iri(10)}` })
        .where(eq(legislationDocuments.id, documentId(9)));
      await db.insert(legislationDocuments).values({
        id: documentId(10),
        sourceId: SOURCE_ID,
        eli: "eli/cz/sb/2000/9",
        title: "A second row claiming the same version",
        country: "CZE",
        language: "cs",
        versionValidFrom: "2021-01-01",
        metadata: { versionIri: iri(10) },
      });

      await runPass();

      expect(await idsOf([documentId(9), documentId(10)])).toEqual([
        `esel:${iri(10)}`,
        null,
      ]);
    });

    test("an id too long to store, or one two unclaimed rows could take, is left unclaimed and reported", async () => {
      await insertLegacy(12, {
        metadata: { versionIri: `https://example.test/${"x".repeat(1100)}` },
      });
      await insertLegacy(13);
      await db.insert(legislationDocuments).values({
        id: documentId(14),
        sourceId: SOURCE_ID,
        eli: "eli/cz/sb/2000/13",
        title: "A second unclaimed row naming the same version",
        country: "CZE",
        language: "cs",
        versionValidFrom: "2021-01-01",
        metadata: { versionIri: iri(13) },
      });
      await insertLegacy(15);

      // The rows around them are still claimed: nothing poisons the page.
      await runPass();

      expect(await idsOf([12, 13, 14, 15].map(documentId))).toEqual([
        null,
        null,
        null,
        `esel:${iri(15)}`,
      ]);

      // Nothing is left behind silently: each skipped row is named with its
      // reason, and the run's totals count it.
      const { lines, logger: recording } = recordingLogger();
      await runPass(createTask(), recording);
      const skips = lines.filter(
        ({ message }) =>
          message === "scheduler.legislation_expression_ids_skipped",
      );
      const skippedIds = (reason: string) =>
        skips
          .filter(
            ({ attributes }) =>
              attributes["legislationExpressionIds.reason"] === reason,
          )
          .flatMap(({ attributes }) =>
            String(attributes["legislationExpressionIds.documentIds"]).split(
              ",",
            ),
          );
      expect(skippedIds("oversized-id")).toEqual([documentId(12)]);
      // Row 10 is the earlier test's: its IRI is already another row's id.
      expect(skippedIds("ambiguous-id").toSorted()).toEqual(
        [documentId(10), documentId(13), documentId(14)].toSorted(),
      );
      // The rows the first test leaves without an IRI or a namespace.
      expect(skippedIds("no-version-iri")).toEqual([documentId(6)]);
      expect(skippedIds("no-namespace")).toEqual([documentId(7)]);
      const summary = lines.find(
        ({ message }) =>
          message === "scheduler.legislation_expression_ids_backfilled",
      );
      expect(summary?.attributes).toMatchObject({
        "legislationExpressionIds.skipped.oversizedId": 1,
        "legislationExpressionIds.skipped.ambiguousId": 3,
        "legislationExpressionIds.skipped.noVersionIri": 1,
        "legislationExpressionIds.skipped.sourceUnprefixed": 1,
      });
    });

    test("the writer finds a row the backfill claimed first, by its id", async () => {
      await insertLegacy(11);
      await runPass();

      const scopedDb: ScopedDb = async (callback) =>
        await db.transaction(async (tx) => await callback(asTestRaw(tx)));
      const corpus = {
        mode: "off",
        write: async (input) =>
          await Promise.resolve(
            (() => {
              const plan = planCorpusDocumentWrite(input);
              return plan.type === "put"
                ? { type: "written" as const, written: plan.written }
                : plan;
            })(),
          ),
      } satisfies LegislationCorpusDependencies;
      const result = await processLegislationDocument(
        {
          sourceId: SOURCE_ID,
          eli: "eli/cz/sb/2000/11",
          title: "Act 2000/11",
          country: "CZE",
          language: "cs",
          version: {
            type: "consolidation",
            validFrom: "2020-01-01",
            end: { type: "open" },
          },
          expression: { publisherId: `esel:${iri(11)}` },
          metadata: { versionIri: iri(11) },
          rawHash: "raw-11",
        },
        scopedDb,
        { corpus },
      );

      expect(result).toMatchObject({ type: "stored", id: documentId(11) });
    });

    const resetFromLegacyCursor = async (n: number) => {
      await db
        .delete(databaseBackfillStates)
        .where(
          eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.expressionIds),
        );
      await db
        .update(schedulerJobs)
        .set({ payload: { cursor: documentId(n) } })
        .where(eq(schedulerJobs.id, JOB_ID));
    };

    test("a load hold preserves the adopted cursor and schedules no continuation", async () => {
      await insertLegacy(16);
      await resetFromLegacyCursor(15);
      const { lines, logger: recording } = recordingLogger();
      expect(
        await run(
          createTask({
            pageRows: 1,
            clock: () => 100_000,
            readVerdict: async () =>
              await Promise.resolve({ kind: "stop", signals: [] }),
          }),
          recording,
        ),
      ).toBe(false);
      expect(await cursor()).toBe(documentId(15));
      expect(await idsOf([documentId(16)])).toEqual([null]);
      expect(
        lines.filter(
          ({ message }) =>
            message === "scheduler.legislation_expression_ids_held",
        ),
      ).toHaveLength(1);
      expect(
        lines.some(
          ({ message }) =>
            message === "scheduler.legislation_expression_ids_backfilled",
        ),
      ).toBe(false);
    });

    test("the first durable page adopts the old payload cursor instead of restarting at the beginning", async () => {
      await insertLegacy(17);
      await resetFromLegacyCursor(16);
      expect(await run(createTask({ pageRows: 1 }))).toBe(true);
      expect(await cursor()).toBe(documentId(17));
      // Row 16 is claimable but precedes the old payload cursor.
      expect(await idsOf([documentId(16), documentId(17)])).toEqual([
        null,
        `esel:${iri(17)}`,
      ]);
    });

    test("a continuation respects durable pacing rather than only the minimum delay", async () => {
      await resetFromLegacyCursor(15);
      await db.insert(databaseBackfillStates).values({
        name: SCHEDULER_BACKFILL_IDS.expressionIds,
        cursor: documentId(15),
        batch: {
          ...initialBatchState(SCHEDULER_BACKFILL_CONFIG),
          size: 1,
          sleepMs: 10_000,
        },
      });
      expect(await run(createTask({ pageRows: 1, clock: () => 100_000 }))).toBe(
        true,
      );
      expect(continuationAt?.getTime()).toBe(105_000);
      expect(await cursor()).toBe(documentId(16));
      expect(await idsOf([documentId(16)])).toEqual([`esel:${iri(16)}`]);
    });

    test.each([null, 105_000])(
      "a timeout failure propagates its database cause even with hold deadline %p",
      async (holdUntil) => {
        const cause = Object.assign(new Error("statement timeout"), {
          code: "57014",
        });
        const failure = new BackfillFailedError({
          message: "expression batch statement timeout",
          cause,
          holdUntil,
          heldSince: holdUntil === null ? null : 100_000,
        });
        const { lines, logger: recording } = recordingLogger();
        const task = createTask({
          createRuntime: (options) => ({
            ...createRuntime(options),
            step: async () => await Promise.reject(failure),
          }),
        });
        const outcome = await run(task, recording);
        if (typeof outcome === "boolean") {
          panic("Expected expression scheduler failure");
        }
        const rejected = outcome.error.cause;
        expect(rejected).toBe(failure);
        expect(isPgError(rejected, PG_ERROR.QUERY_CANCELED)).toBe(true);
        expect(continuationAt).toBeUndefined();
        expect(
          lines.some(
            ({ message }) =>
              message === "scheduler.legislation_expression_ids_held",
          ),
        ).toBe(false);
        expect(
          lines.some(
            ({ message }) =>
              message === "scheduler.legislation_expression_ids_backfilled",
          ),
        ).toBe(false);
      },
    );

    test.skipIf(engine !== "postgres")(
      "a statement timeout fails the scheduler run, rolls back the page, and is never logged as held",
      async () => {
        await insertLegacy(18);
        await resetFromLegacyCursor(17);
        await db.execute(sql`CREATE FUNCTION expression_page_delay() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(1);
          RETURN NEW;
        END
      $$`);
        await db.execute(
          sql`CREATE TRIGGER expression_page_delay BEFORE UPDATE ON legislation_documents FOR EACH ROW EXECUTE FUNCTION expression_page_delay()`,
        );
        const { lines, logger: recording } = recordingLogger();
        try {
          const outcome = await run(
            createTask({
              pageRows: 1,
              createRuntime: (options) =>
                createRuntime({
                  ...options,
                  config: {
                    ...SCHEDULER_BACKFILL_CONFIG,
                    ...options.config,
                    batchStatementTimeoutMs: 100,
                  },
                }),
            }),
            recording,
          );
          if (typeof outcome === "boolean") {
            panic("Expected real expression statement timeout");
          }
          const rejected = outcome.error.cause;
          expect(rejected).toBeInstanceOf(BackfillFailedError);
          expect(isPgError(rejected, PG_ERROR.QUERY_CANCELED)).toBe(true);
          expect(await cursor()).toBe(documentId(17));
          expect(await idsOf([documentId(18)])).toEqual([null]);
          expect(continuationAt).toBeUndefined();
          expect(
            lines.some(
              ({ message }) =>
                message === "scheduler.legislation_expression_ids_held",
            ),
          ).toBe(false);
          expect(
            lines.some(
              ({ message }) =>
                message === "scheduler.legislation_expression_ids_backfilled",
            ),
          ).toBe(false);
          const checkpoint = (
            await db
              .select()
              .from(databaseBackfillStates)
              .where(
                eq(
                  databaseBackfillStates.name,
                  SCHEDULER_BACKFILL_IDS.expressionIds,
                ),
              )
          ).at(0);
          expect(checkpoint?.batch.holdUntil).toBeNull();
          const job =
            (
              await db
                .select()
                .from(schedulerJobs)
                .where(eq(schedulerJobs.id, JOB_ID))
                .limit(1)
            ).at(0) ?? panic("Expected expression scheduler job");
          const telemetry = installRecordingLogger();
          try {
            expect(
              await runJob({
                db: asTestRaw<SchedulerDb>(db),
                job,
                heartbeatIntervalMs: 60_000,
                leaseMs: 180_000,
                maxRuntimeMs: 10_000,
                runnerId: "expression-timeout-runner",
                registry: new Map([
                  [
                    BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
                    createTask({
                      pageRows: 1,
                      createRuntime: (options) =>
                        createRuntime({
                          ...options,
                          config: {
                            ...SCHEDULER_BACKFILL_CONFIG,
                            ...options.config,
                            batchStatementTimeoutMs: 100,
                          },
                        }),
                    }),
                  ],
                ]),
                signal: undefined,
              }),
            ).toBe("failed");
            const runRow = (
              await db
                .select()
                .from(schedulerJobRuns)
                .where(eq(schedulerJobRuns.jobId, JOB_ID))
                .limit(1)
            ).at(0);
            expect(runRow?.status).toBe("failed");
            expect(runRow?.error).toBe("BackfillFailedError");
            const failure = telemetry.records.find(
              (record) => record.message === "scheduler.job_failed",
            );
            expect(failure?.attributes?.["error.cause.pg_code"]).toBe("57014");
          } finally {
            telemetry.restore();
          }
        } finally {
          await db.execute(
            sql`DROP TRIGGER expression_page_delay ON legislation_documents`,
          );
          await db.execute(sql`DROP FUNCTION expression_page_delay()`);
        }
      },
    );
  });
};
