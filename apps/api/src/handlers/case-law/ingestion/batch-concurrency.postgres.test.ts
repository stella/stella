import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { deferred, waitFor } from "@stll/test-kit";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
} from "@/api/db/schema";
import { tryResolveCitationBatch } from "@/api/handlers/case-law/citation-resolution";
import type {
  CaseLawIngestionBatchRecord,
  RejectedCaseLawIngestionRecord,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import {
  connectOrderingKeys,
  decisionOrderingKeys,
  planDecisionOrdering,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-ordering";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { CorpusPackError } from "@/api/lib/legal-search/corpus-pack";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  courtListenerIngestFixture,
  czechIngestFixture,
} from "@/api/tests/helpers/case-law-ingest-fixture";
import {
  type AppliedBatch,
  applyIngestStream,
  batchHoldsCursor,
  canonicalCaseLawState,
  cloneCaseLawSchema,
  dropCaseLawSchema,
  insertIngestSource,
  objectStoreCorpus,
  schemaScopedDb,
} from "@/api/tests/helpers/case-law-ingest-schema";
import { type FakeS3Hold, startFakeS3 } from "@/api/tests/helpers/fake-s3";

const databaseUrl = process.env["DATABASE_URL"];

/** The child maps the stream and writes a whole batch before the kill point. */
const CRASH_POINT_WAIT_MS = 300_000;
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

  /**
   * Apply until every batch settles, as a crawl re-reads a held page: each
   * pass resumes at the batch the previous one held on, under a later
   * observation.
   */
  const applyUntilSettled = async (
    options: Omit<
      Parameters<typeof applyIngestStream>[0],
      "firstOrder" | "fromBatch"
    >,
  ): Promise<{ passes: number; applied: AppliedBatch[] }> => {
    const applied: AppliedBatch[] = [];
    let fromBatch = 0;
    for (let pass = 1; pass <= 6; pass++) {
      const batches = await applyIngestStream({
        ...options,
        firstOrder: BigInt(pass * 10),
        fromBatch,
      });
      applied.push(...batches);
      const held = batches.findIndex(batchHoldsCursor);
      if (held === -1) {
        return { passes: pass, applied };
      }
      fromBatch += held;
    }
    return panic("The stream did not settle in six passes");
  };

  const decisionRows = async (scopedDb: ScopedDb): Promise<number> =>
    await scopedDb(
      async (tx) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(caseLawDecisions)
        ).at(0)?.count ?? 0,
    );

  /** The packs the run's rows reference, and those its store lacks. */
  const referencedPacks = async (
    scopedDb: ScopedDb,
    store: ReturnType<typeof startFakeS3>,
  ): Promise<{ referenced: number; missing: string[] }> => {
    const keys = await scopedDb(async (tx) =>
      executedRows(
        await tx.execute(
          sql`SELECT DISTINCT pack_key::text AS key FROM case_law_corpus_pack_refs`,
        ),
      ).map((row) =>
        isRecord(row) && typeof row["key"] === "string"
          ? row["key"]
          : panic("Pack reference without a key"),
      ),
    );
    const stored = [...store.objects.keys()];
    return {
      referenced: keys.length,
      missing: keys.filter(
        (key) => !stored.some((object) => object.endsWith(`/${key}`)),
      ),
    };
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
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          // Each run has an object store of its own: pack keys follow
          // content, so a shared store would let the second run reuse the
          // first one's objects without uploading its own.
          const applyTwice = async (concurrency: number, max: number) => {
            const fakeS3 = startFakeS3();
            try {
              return await withRun(
                { openClient, sourceId, max },
                async (run) => {
                  await insertIngestSource(
                    run.scopedDb,
                    czechSourceId,
                    "cz-ns",
                  );
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
                    state: await canonicalCaseLawState(
                      run.scopedDb,
                      run.tables,
                    ),
                    packs: await referencedPacks(run.scopedDb, fakeS3),
                  };
                },
              );
            } finally {
              fakeS3.stop();
            }
          };
          const serial = await applyTwice(1, 2);
          // Fewer connections than decisions in flight: a decision that
          // held one connection while it waited for another would hang.
          const concurrent = await applyTwice(16, 4);
          expect(serial.tallies.every(({ halt }) => halt === null)).toBe(true);
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
          // Every pack the stored rows reference was uploaded by the run
          // that stored them.
          for (const { referenced, missing } of [
            serial.packs,
            concurrent.packs,
          ]) {
            expect(referenced).toBeGreaterThan(0);
            expect(missing).toEqual([]);
          }
        });
      },
      10 * 60_000,
    );

    // timeout: ingests one decision, then reads what a batch's records reach.
    test(
      "records naming one stored decision by different aliases are ordered together",
      async () => {
        const sourceId = createSafeId<"caseLawSource">();
        const fakeS3 = startFakeS3();
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            await withRun({ openClient, sourceId, max: 2 }, async (run) => {
              const [stored, elsewhere, unrelated] = courtListenerIngestFixture(
                { count: 3, namespace: 7105 },
              );
              if (
                stored?.sourceDocumentId === undefined ||
                elsewhere === undefined ||
                unrelated === undefined
              ) {
                return panic("The fixture lost its records");
              }
              await applyIngestStream({
                scopedDb: run.scopedDb,
                sourceId,
                decisions: [stored],
                concurrency: 1,
                corpus: landing(),
              });
              // An earlier re-key left a second publisher identity
              // registered for the stored decision.
              await run.scopedDb(async (tx) => {
                const row = await tx
                  .select({ id: caseLawDecisions.id })
                  .from(caseLawDecisions)
                  .where(
                    eq(
                      caseLawDecisions.sourceDocumentId,
                      stored.sourceDocumentId ?? "",
                    ),
                  )
                  .limit(1);
                const decisionId =
                  row.at(0)?.id ?? panic("The stored decision is missing");
                await tx.insert(caseLawDecisionSourceIdentities).values({
                  sourceId,
                  sourceDocumentId: "reissued-identity",
                  decisionId,
                });
              });
              // A record under that identity, of another docket, citation
              // and text: nothing it states meets the stored record.
              const reissued: IngestionResult = {
                ...elsewhere,
                sourceDocumentId: "reissued-identity",
                sourceDocumentIdAliases: undefined,
                sourceDocumentIdRepairAliases: undefined,
              };
              const records: CaseLawIngestionBatchRecord[] = [
                stored,
                reissued,
                unrelated,
              ].map((decision) => ({ type: "decision", decision }));
              const contract = await createSourceContractResolver(run.scopedDb)(
                sourceId,
              );
              const stated = connectOrderingKeys(
                records.map((record) =>
                  decisionOrderingKeys(record, sourceId, contract),
                ),
              );
              expect(stated[1]).not.toEqual(stated[0]);
              const planned = await planDecisionOrdering({
                records,
                sourceId,
                contract,
                scopedDb: run.scopedDb,
              });
              expect(planned?.[1]).toEqual(planned?.[0]);
              expect(planned?.[2]).not.toEqual(planned?.[0]);
            });
          });
        } finally {
          fakeS3.stop();
        }
      },
      5 * 60_000,
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
                // The first batch's pack upload, then the second batch's
                // first raw write, held in the store: the child is killed
                // while that write is in flight.
                const firstPack = fakeS3.holdNext({
                  method: "PUT",
                  keyIncludes: "/packs/",
                });
                let secondBatchWrite: FakeS3Hold | undefined;
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
                const reach = async (hold: FakeS3Hold, description: string) => {
                  await waitFor(
                    () =>
                      hold.isReached || child.exitCode !== null
                        ? true
                        : undefined,
                    {
                      description,
                      intervalMs: 5,
                      timeoutMs: CRASH_POINT_WAIT_MS,
                    },
                  );
                  if (!hold.isReached) {
                    panic(`The child exited before ${description}`);
                  }
                };
                try {
                  await reach(firstPack, "the first batch's pack upload");
                  secondBatchWrite = fakeS3.holdNext({
                    method: "PUT",
                    keyIncludes: "/raw/",
                  });
                  firstPack.release();
                  await reach(
                    secondBatchWrite,
                    "a raw write of the second batch",
                  );
                  child.kill("SIGKILL");
                } finally {
                  // Joined whatever stopped the wait: the schema and the
                  // store outlive the child.
                  if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                  }
                  await child.exited;
                  firstPack.release();
                  secondBatchWrite?.release();
                }
                expect(child.signalCode).toBe("SIGKILL");
                expect(await decisionRows(run.scopedDb)).toBeGreaterThan(0);
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
        // A held batch is read again under a later observation, as a crawl
        // reads a held page again, so its rows carry that observation's
        // order; everything else they hold compares.
        const exclude = {
          case_law_decisions: ["source_observation_order"],
          case_law_decision_source_identities: ["source_observation_order"],
          case_law_ingestion_failure_evidence: ["observation_order"],
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
                  compared(run.tables),
                  exclude,
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
                const { passes, applied } = await applyUntilSettled({
                  scopedDb: run.scopedDb,
                  sourceId,
                  decisions,
                  concurrency: 16,
                  corpus,
                });
                expect(passes).toBeGreaterThan(1);
                expect(
                  applied.some(({ halt }) => halt?.type === "retryable"),
                ).toBe(true);
                expect(
                  applied.some(
                    ({ corpusWriteFailures }) => corpusWriteFailures > 0,
                  ),
                ).toBe(true);
                const ledgers = await canonicalCaseLawState(
                  run.scopedDb,
                  cleanupLedgers,
                );
                // The refused raw writes are queued for the sweep, and the
                // lost pack's intents wait for cleanup, none left active.
                expect(ledgers["case_law_raw_sweeps"]?.length).toBeGreaterThan(
                  0,
                );
                const intents = ledgers["case_law_corpus_upload_intents"] ?? [];
                expect(intents.length).toBeGreaterThan(0);
                expect(
                  intents.every((row) => row.includes('"status":"cleanup"')),
                ).toBe(true);
                return await canonicalCaseLawState(
                  run.scopedDb,
                  compared(run.tables),
                  exclude,
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
              const stop = new AbortController();
              const ingest = applyIngestStream({
                scopedDb: run.scopedDb,
                sourceId,
                decisions,
                concurrency: 16,
                corpus: landing(),
                signal: stop.signal,
              }).finally(() => {
                finished.resolve();
              });
              let admitted = 0;
              let declined = 0;
              const walked = await Result.tryPromise({
                try: async () => {
                  // Counted from the first graph write on: a decision row
                  // exists only once a graph transaction committed it.
                  await waitFor(
                    async () =>
                      finished.settled() || (await decisionRows(walk)) > 0
                        ? true
                        : undefined,
                    {
                      description: "the ingest's first graph write",
                      intervalMs: 5,
                      timeoutMs: CRASH_POINT_WAIT_MS,
                    },
                  );
                  while (!finished.settled()) {
                    const batch = await tryResolveCitationBatch(walk, {
                      limit: 25,
                    });
                    // An answer after the ingest finished is not one taken
                    // against its graph writes.
                    if (finished.settled()) {
                      break;
                    }
                    if (batch === null) {
                      declined++;
                    } else {
                      admitted++;
                    }
                  }
                },
                catch: (cause) => cause,
              });
              if (Result.isError(walked)) {
                // The ingest stops and is joined before the schema goes.
                stop.abort();
                await Result.tryPromise({
                  try: async () => await ingest,
                  catch: (cause) => cause,
                });
                return panic("The citation walk failed", walked.error);
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
