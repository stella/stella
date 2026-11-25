import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { deferred, waitFor } from "@stll/test-kit";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import { tryResolveCitationBatch } from "@/api/handlers/case-law/citation-resolution";
import type { RejectedCaseLawIngestionRecord } from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { CorpusPackError } from "@/api/lib/legal-search/corpus-pack";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  courtListenerIngestFixture,
  czechIngestFixture,
} from "@/api/tests/helpers/case-law-ingest-fixture";
import {
  type AppliedBatch,
  applyIngestStream,
  canonicalCaseLawState,
  cloneCaseLawSchema,
  dropCaseLawSchema,
  insertIngestSource,
  objectStoreCorpus,
  schemaScopedDb,
} from "@/api/tests/helpers/case-law-ingest-schema";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" && Boolean(databaseUrl);
if (!databaseUrl || !enabled) {
  describe.skip("batch concurrency (postgres)", () => {
    test("requires the gated PostgreSQL runner", () => {});
  });
} else {
  type Run = {
    scopedDb: ScopedDb;
    tables: string[];
    schemaName: string;
  };

  /**
   * One run in its own copy of the case-law tables. Every run of a test
   * uses the same source id, so slug candidates (keyed by it) compare.
   */
  const withRun = async <T>(
    {
      openClient,
      sourceId,
      max,
    }: {
      openClient: Parameters<
        Parameters<typeof withGatedTestClients>[1]
      >[0]["openClient"];
      sourceId: SafeId<"caseLawSource">;
      max: number;
    },
    run: (run: Run) => Promise<T>,
  ): Promise<T> => {
    const admin = openClient({ max: 1 });
    const { db } = openClient({ max });
    const schemaName = `ingest_run_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const tables = await cloneCaseLawSchema(admin.db, schemaName);
    try {
      const scopedDb = schemaScopedDb(db, schemaName);
      await insertIngestSource(scopedDb, sourceId);
      return await run({ scopedDb, tables, schemaName });
    } finally {
      await dropCaseLawSchema(admin.db, schemaName);
    }
  };

  const landing = () => objectStoreCorpus();

  const rejection = (n: number): RejectedCaseLawIngestionRecord => ({
    type: "rejected",
    recordKey: `rejected-${n}`,
    recordHash: `hash-${n}`,
    language: "en",
    reason: "unmappable",
    message: "The record does not map to a decision",
  });

  /**
   * The stream every comparison applies: the measured fixture with two
   * source rejections among its records, over three batches.
   */
  const stream = (namespace: number) => {
    const decisions: (IngestionResult | RejectedCaseLawIngestionRecord)[] =
      courtListenerIngestFixture({ count: 420, namespace });
    decisions.splice(150, 0, rejection(1));
    decisions.splice(310, 0, rejection(2));
    return decisions;
  };

  /** What a batch reported, without the ledger's generated ids. */
  const tallies = (applied: readonly AppliedBatch[]) =>
    applied.map(
      ({ inserted, skipped, halt, settlements, corpusWriteFailures }) => ({
        inserted,
        skipped,
        halt,
        settlements,
        corpusWriteFailures,
      }),
    );

  /** Apply until every batch settles, as a crawl re-reads a held page. */
  const applyUntilSettled = async (
    options: Parameters<typeof applyIngestStream>[0],
  ): Promise<number> => {
    for (let pass = 1; pass <= 6; pass++) {
      const applied = await applyIngestStream({
        ...options,
        firstOrder: BigInt(pass * 10),
      });
      if (applied.every(({ halt }) => halt === null)) {
        return pass;
      }
    }
    return panic("The stream did not settle in six passes");
  };

  describe("batch concurrency (postgres)", () => {
    // timeout: applies hundreds of decisions twice, once serially, on a real database.
    test(
      "a concurrent batch writes what the serial batch writes",
      async () => {
        const decisions = stream(7101);
        const czech = czechIngestFixture({ count: 240 });
        const sourceId = createSafeId<"caseLawSource">();
        const czechSourceId = createSafeId<"caseLawSource">();
        const fakeS3 = startFakeS3();
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const applyTwice = async (concurrency: number, max: number) =>
              await withRun({ openClient, sourceId, max }, async (run) => {
                await insertIngestSource(run.scopedDb, czechSourceId, "cz-ns");
                const first = await applyIngestStream({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency,
                  corpus: landing(),
                });
                // Decisions that cite each other by docket: the graph
                // resolves a citation on write or on its target's arrival.
                const cited = await applyIngestStream({
                  scopedDb: run.scopedDb,
                  sourceId: czechSourceId,
                  decisions: czech,
                  concurrency,
                  corpus: landing(),
                });
                // The same pages again: every record is now an unchanged
                // observation of a stored row.
                const again = await applyIngestStream({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency,
                  corpus: landing(),
                  firstOrder: 10n,
                });
                return {
                  tallies: tallies([...first, ...cited, ...again]),
                  state: await canonicalCaseLawState(run.scopedDb, run.tables),
                };
              });
            const serial = await applyTwice(1, 2);
            // Fewer connections than decisions in flight: a decision that
            // held one connection while it waited for another would hang.
            const concurrent = await applyTwice(16, 4);
            expect(serial.tallies.every(({ halt }) => halt === null)).toBe(
              true,
            );
            expect(
              serial.state["case_law_decisions"]?.length ?? 0,
            ).toBeGreaterThan(400);
            const citations = serial.state["case_law_citations"] ?? [];
            expect(citations.length).toBeGreaterThan(400);
            // Resolved both ways: to a decision written before the citing one
            // and to one written after it.
            expect(
              citations.filter((row) =>
                row.includes('"cited_decision_id":"decision:'),
              ).length,
            ).toBeGreaterThan(400);
            expect(concurrent.tallies).toEqual(serial.tallies);
            expect(concurrent.state).toEqual(serial.state);
          });
        } finally {
          fakeS3.stop();
        }
      },
      10 * 60_000,
    );

    // timeout: applies the stream serially for a reference, then crashes and resumes a run.
    test(
      "a run killed mid-batch resumes to the state of one that was not",
      async () => {
        const namespace = 7102;
        const count = 420;
        const decisions = courtListenerIngestFixture({ count, namespace });
        const sourceId = createSafeId<"caseLawSource">();
        const fakeS3 = startFakeS3();
        // The crashed run's surviving rows keep the observation that wrote
        // them, and a reservation it made before it died is left for the
        // expiry sweep, as after any crash.
        const exclude = {
          case_law_decisions: ["source_observation_order"],
        };
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const reference = await withRun(
              { openClient, sourceId, max: 2 },
              async (run) => {
                await applyUntilSettled({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 1,
                  corpus: landing(),
                });
                return await canonicalCaseLawState(
                  run.scopedDb,
                  run.tables.filter(
                    (table) => table !== "case_law_corpus_upload_intents",
                  ),
                  exclude,
                );
              },
            );
            const resumed = await withRun(
              { openClient, sourceId, max: 8 },
              async (run) => {
                const child = Bun.spawn({
                  cmd: [
                    process.execPath,
                    fileURLToPath(
                      new URL(
                        "../../../tests/helpers/case-law-ingest-crash-child.ts",
                        import.meta.url,
                      ),
                    ),
                    "--s3",
                    fakeS3.endpoint,
                    "--schema",
                    run.schemaName,
                    "--source",
                    sourceId,
                    "--count",
                    String(count),
                    "--namespace",
                    String(namespace),
                    "--concurrency",
                    "16",
                  ],
                  env: process.env,
                  stdout: "ignore",
                  stderr: "inherit",
                });
                const written = async () =>
                  await run.scopedDb(
                    async (tx) =>
                      (
                        await tx
                          .select({ count: sql<number>`count(*)::int` })
                          .from(caseLawDecisions)
                      ).at(0)?.count ?? 0,
                  );
                // Killed in the second batch, with decisions in flight.
                const rows = await waitFor(
                  async () => {
                    const counted = await written();
                    return counted >= 260 || child.exitCode !== null
                      ? counted
                      : undefined;
                  },
                  {
                    description: "the killed run to reach its second batch",
                    intervalMs: 5,
                    // timeout: the child first maps the stream and writes a whole batch.
                    timeoutMs: 5 * 60_000,
                  },
                );
                child.kill("SIGKILL");
                await child.exited;
                expect(child.signalCode).toBe("SIGKILL");
                expect(rows).toBeGreaterThanOrEqual(260);
                expect(rows).toBeLessThan(count);
                // A new process: nothing carried over but the database.
                await applyUntilSettled({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 16,
                  corpus: landing(),
                });
                return await canonicalCaseLawState(
                  run.scopedDb,
                  run.tables.filter(
                    (table) => table !== "case_law_corpus_upload_intents",
                  ),
                  exclude,
                );
              },
            );
            expect(resumed).toEqual(reference);
          });
        } finally {
          fakeS3.stop();
        }
      },
      10 * 60_000,
    );

    // timeout: applies the stream serially for a reference, then again under faults.
    test(
      "object storage faults hold the batch, and applying it again converges",
      async () => {
        const decisions = stream(7103);
        const sourceId = createSafeId<"caseLawSource">();
        const fakeS3 = startFakeS3();
        // What a fault leaves for the sweepers: the abandoned raw objects
        // and the lost pack's upload intents. Asserted on their own below;
        // every other table compares row for row.
        const cleanupLedgers = [
          "case_law_raw_sweeps",
          "case_law_corpus_upload_intents",
        ];
        const compared = (tables: readonly string[]) =>
          tables.filter((table) => !cleanupLedgers.includes(table));
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const reference = await withRun(
              { openClient, sourceId, max: 2 },
              async (run) => {
                await applyUntilSettled({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 1,
                  corpus: landing(),
                });
                return await canonicalCaseLawState(
                  run.scopedDb,
                  compared(run.tables),
                );
              },
            );
            const faulted = await withRun(
              { openClient, sourceId, max: 4 },
              async (run) => {
                // Raw source writes refused outright (no retry clears them),
                // spread over the first batch's concurrent decisions, and
                // one pack upload lost.
                fakeS3.failNext({
                  method: "PUT",
                  code: "AccessDenied",
                  status: 403,
                  keyIncludes: "/raw/",
                  times: 5,
                });
                let packs = 0;
                const corpus = objectStoreCorpus(async (write) => {
                  packs++;
                  return packs === 2
                    ? Result.err(
                        new CorpusPackError({ message: "bucket unreachable" }),
                      )
                    : await write();
                });
                const first = await applyIngestStream({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 16,
                  corpus,
                });
                expect(
                  first.some(({ halt }) => halt?.type === "retryable"),
                ).toBe(true);
                expect(
                  first.some(
                    ({ corpusWriteFailures }) => corpusWriteFailures > 0,
                  ),
                ).toBe(true);
                const passes = await applyUntilSettled({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 16,
                  corpus,
                });
                expect(passes).toBeGreaterThanOrEqual(1);
                const ledgers = await canonicalCaseLawState(
                  run.scopedDb,
                  cleanupLedgers,
                );
                // The refused raw writes are queued for the sweep, and the
                // lost pack's intents wait for cleanup, none left active.
                expect(ledgers["case_law_raw_sweeps"]?.length).toBeGreaterThan(
                  0,
                );
                expect(
                  (ledgers["case_law_corpus_upload_intents"] ?? []).every(
                    (row) => row.includes('"status":"cleanup"'),
                  ),
                ).toBe(true);
                return await canonicalCaseLawState(
                  run.scopedDb,
                  compared(run.tables),
                );
              },
            );
            expect(faulted).toEqual(reference);
          });
        } finally {
          fakeS3.stop();
        }
      },
      10 * 60_000,
    );

    // timeout: ingests 600 decisions while the walk takes its turns.
    test(
      "the standing citation walk is admitted while a concurrent ingest runs",
      async () => {
        const decisions = courtListenerIngestFixture({
          count: 600,
          namespace: 7104,
        });
        const sourceId = createSafeId<"caseLawSource">();
        const fakeS3 = startFakeS3();
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            await withRun({ openClient, sourceId, max: 8 }, async (run) => {
              const walk = schemaScopedDb(
                openClient({ max: 1 }).db,
                run.schemaName,
              );
              const finished = deferred();
              const ingest = applyIngestStream({
                scopedDb: run.scopedDb,
                sourceId,
                decisions,
                concurrency: 16,
                corpus: landing(),
              }).finally(() => {
                finished.resolve();
              });
              let admitted = 0;
              let declined = 0;
              while (!finished.settled()) {
                const batch = await tryResolveCitationBatch(walk, {
                  limit: 25,
                });
                if (batch === null) {
                  declined++;
                } else {
                  admitted++;
                }
              }
              const applied = await ingest;
              expect(applied.every(({ halt }) => halt === null)).toBe(true);
              expect(admitted + declined).toBeGreaterThan(5);
              expect(admitted).toBeGreaterThan(0);
            });
          });
        } finally {
          fakeS3.stop();
        }
      },
      10 * 60_000,
    );
  });
}
