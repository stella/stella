import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  EMPTY_AST,
  StoredRawReadError,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { PublisherRateLimitRefusalError } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  parseEcjFormexRefreshIds,
  runEcjFormexRefresh as runRefresh,
} from "@/api/scripts/eu-ecj-formex-refresh";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const expectFailure = async (run: () => Promise<unknown>, message: string) => {
  const failed = await Result.tryPromise({ try: run, catch: (cause) => cause });
  expect(Result.isError(failed)).toBe(true);
  if (Result.isError(failed)) {
    expect(failed.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
  }
};

type RunnerOptions = Parameters<typeof runRefresh>[0];
type Outcome = Awaited<
  ReturnType<NonNullable<RunnerOptions["refreshStoredFormex"]>>
>;

const runEcjFormexRefresh = async (options: RunnerOptions) => {
  const summary = await runRefresh(options);
  expect(summary.type).toBe("complete");
  if (summary.type !== "complete") {
    throw new TypeError("Unexpected rate-limited test result");
  }
  return summary.results;
};

test("validates the entire identity list and rejects duplicate or malformed lines", () => {
  const id = createSafeId<"caseLawDecision">();
  expect(parseEcjFormexRefreshIds(`${id}\r\n62020CJ0001:cs\n`)).toHaveLength(2);
  for (const input of [
    "",
    "junk",
    "62020CJ0001:CS",
    "62020CJ0001:cs:en",
    `${id}\n${id}`,
  ]) {
    expect(() => parseEcjFormexRefreshIds(input)).toThrow(
      /identit|contains no/u,
    );
  }
});

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("stored EU-ECJ refresh durability (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  const withFixture = async (
    work: (
      options: RunnerOptions,
      state: {
        ids: string[];
        directory: string;
        writes: string[];
        outcomes: Outcome[];
        acquireBetween: () => Promise<void>;
      },
    ) => Promise<void>,
  ) =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const ingestionDb = createIngestionDb(markRlsDatabase(db));
      const source = caseLawSourceRow({
        adapterKey: `eu-ecj-refresh-test-${Bun.randomUUIDv7()}`,
      });
      const directory = await mkdtemp(
        path.join(tmpdir(), "ecj-formex-refresh-"),
      );
      const ids = Array.from({ length: 7 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted();
      const writes: string[] = [];
      const outcomes: Outcome[] = [
        { type: "notice-missing" },
        { type: "formex-not-located" },
        { type: "formex-gone" },
        { type: "retryable-exhausted" },
        { type: "write-rejected", rejection: "identity" },
        { type: "unchanged-already-current" },
      ];
      const acquireBetween = async () => {
        const other = await acquireCaseLawSourceIngestionLease({
          scopedDb: ingestionDb,
          sourceId: source.id,
        });
        expect(other).not.toBeNull();
        await other?.release();
      };
      const decision = {
        caseNumber: "C-1/20",
        sourceDocumentId: "62020CJ0001:cs",
        country: "EU",
        court: "Court of Justice",
        language: "cs",
        fulltext: "The Court gives judgment in the dispute.",
        metadata: {},
        documentAst: EMPTY_AST,
        rawHash: "test-hash",
        sourceRaw: "archive-current",
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      } satisfies IngestionResult;
      outcomes.push({
        type: "refreshed",
        decision,
        formexShape: "archive",
        bytes: 15,
      });
      try {
        await db.insert(caseLawSources).values(source);
        await db.insert(caseLawDecisions).values(
          ids.map((id, index) => ({
            id,
            sourceId: source.id,
            sourceDocumentId: `62020CJ000${index + 1}:cs`,
            country: "EU",
            court: "Court of Justice",
            language: "cs",
            caseNumber: `C-${index + 1}/20`,
            sourceRawS3Key: `raw-${index}`,
            sourceRawContentType: "application/xml",
          })),
        );
        const idsFile = path.join(directory, "ids.txt");
        await Bun.write(idsFile, ids.join("\n"));
        const options = {
          ingestionDb,
          sourceId: source.id,
          idsFile,
          resultsOut: path.join(directory, "results.jsonl"),
          apply: true,
          batchSize: 2,
          acquireBatch: async () => {
            await acquireBetween();
            const sourceLease = await acquireCaseLawSourceIngestionLease({
              scopedDb: ingestionDb,
              sourceId: source.id,
            });
            if (sourceLease === null) {
              return null;
            }
            return { ingestionDb, sourceLease, release: sourceLease.release };
          },
          readStoredRaw: async (key) =>
            Result.ok(new TextEncoder().encode(key)),
          refreshStoredFormex: async ({ stored }) => {
            const index = ids.indexOf(
              (
                await db
                  .select({ id: caseLawDecisions.id })
                  .from(caseLawDecisions)
                  .where(
                    eq(
                      caseLawDecisions.sourceDocumentId,
                      stored.sourceDocumentId ?? "",
                    ),
                  )
                  .limit(1)
              ).at(0)?.id ?? "",
            );
            const outcome = outcomes.at(index);
            if (outcome === undefined) {
              throw new TypeError("Fixture outcome missing");
            }
            return outcome.type === "refreshed"
              ? {
                  ...outcome,
                  decision: {
                    ...outcome.decision,
                    sourceDocumentId: stored.sourceDocumentId ?? undefined,
                  },
                }
              : outcome;
          },
          writeDecision: async ({ input, observationOrder, refresh }) => {
            expect(refresh).toBe("always");
            expect(observationOrder).toBeGreaterThan(0n);
            const identity = input.sourceDocumentId ?? "";
            await db
              .update(caseLawDecisions)
              .set({
                sourceRaw: input.sourceRaw,
                sourceRawS3Key: null,
                sourceObservationOrder: observationOrder,
              })
              .where(eq(caseLawDecisions.sourceDocumentId, identity));
            writes.push(identity);
            return {
              status: "complete",
              inserted: true,
              searchVectorFailed: false,
            };
          },
        } satisfies RunnerOptions;
        await work(options, {
          ids,
          directory,
          writes,
          outcomes,
          acquireBetween,
        });
      } finally {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, source.id));
        await rm(directory, { recursive: true, force: true });
      }
    });

  test("accounts once for every row across all outcomes and releases the lease between batches", async () => {
    await withFixture(async (options, { ids, writes, acquireBetween }) => {
      const results = await runEcjFormexRefresh(options);
      expect(results.map(({ id }) => id)).toEqual(ids);
      expect(new Set(results.map(({ outcome }) => outcome))).toEqual(
        new Set([
          "notice-missing",
          "formex-not-located",
          "formex-gone",
          "retryable-exhausted",
          "write-rejected",
          "unchanged-already-current",
          "refreshed",
        ]),
      );
      expect(writes).toHaveLength(1);
      const journal = await Bun.file(options.resultsOut).text();
      expect(journal.trim().split("\n")).toHaveLength(ids.length);
      expect(journal).not.toContain("archive-current");
      expect(await runEcjFormexRefresh(options)).toEqual([]);
      expect(writes).toHaveLength(1);
      expect(await Bun.file(options.resultsOut).text()).toBe(journal);
      await acquireBetween();
    });
  });

  test("a killed run resumes after durable results and discards a torn final journal line", async () => {
    await withFixture(async (options, { ids, outcomes, writes }) => {
      const refreshed = outcomes.at(-1);
      if (refreshed?.type !== "refreshed") {
        throw new TypeError("Missing refreshed fixture");
      }
      outcomes.fill(refreshed);
      let visits = 0;
      const controller = new AbortController();
      const refreshStoredFormex: NonNullable<
        RunnerOptions["refreshStoredFormex"]
      > = async (input) => {
        visits += 1;
        if (visits === 3) {
          controller.abort(new TypeError("Simulated process stop"));
        }
        return await (
          options.refreshStoredFormex ??
          (() => {
            throw new TypeError("Missing refresher");
          })
        )(input);
      };
      await expectFailure(
        async () =>
          runEcjFormexRefresh({
            ...options,
            signal: controller.signal,
            refreshStoredFormex,
          }),
        "Simulated process stop",
      );
      const durable = await Bun.file(options.resultsOut).text();
      await Bun.write(options.resultsOut, `${durable}{"id":`);
      await runEcjFormexRefresh(options);
      expect(new Set(writes).size).toBe(ids.length);
      expect(writes).toHaveLength(ids.length);
      const journal = await Bun.file(options.resultsOut).text();
      expect(journal.trim().split("\n")).toHaveLength(ids.length);
    });
  });

  test("rejects aliases and missing source rows before publisher, storage, or write work", async () => {
    await withFixture(async (options, { ids, writes }) => {
      const first = ids.at(0);
      if (first === undefined) {
        throw new TypeError("Missing fixture row");
      }
      await Bun.write(options.idsFile, `${first}\n62020CJ0001:cs`);
      let reads = 0;
      const readStoredRaw: NonNullable<
        RunnerOptions["readStoredRaw"]
      > = async () => {
        reads += 1;
        return Result.ok(null);
      };
      await expectFailure(
        async () => runEcjFormexRefresh({ ...options, readStoredRaw }),
        "same row",
      );
      await Bun.write(options.idsFile, createSafeId<"caseLawDecision">());
      await expectFailure(
        async () => runEcjFormexRefresh({ ...options, readStoredRaw }),
        "not found in the selected source",
      );
      expect(reads).toBe(0);
      expect(writes).toHaveLength(0);
      expect(await Bun.file(options.resultsOut).exists()).toBe(false);
    });
  });

  test("dry outcomes do not write or acquire a lease and can subsequently be applied", async () => {
    await withFixture(async (options, { ids, writes }) => {
      const results = await runEcjFormexRefresh({
        ...options,
        apply: false,
        acquireBatch: async () => {
          throw new TypeError("Dry run acquired lease");
        },
      });
      expect(results).toHaveLength(ids.length);
      expect(results.every(({ outcome }) => outcome.startsWith("would-"))).toBe(
        true,
      );
      expect(writes).toHaveLength(0);
      expect(await runEcjFormexRefresh(options)).toHaveLength(ids.length);
      expect(writes).toHaveLength(1);
    });
  });

  test("a crash after the database write but before journaling does not repeat an XML write", async () => {
    await withFixture(async (options, { ids, outcomes, writes }) => {
      const refreshed = outcomes.at(-1);
      if (refreshed?.type !== "refreshed") {
        throw new TypeError("Missing refreshed fixture");
      }
      for (let index = 0; index < outcomes.length; index += 1) {
        outcomes[index] = { ...refreshed, formexShape: "xml" };
      }
      const writer = options.writeDecision;
      if (writer === undefined) {
        throw new TypeError("Missing writer");
      }
      await expectFailure(
        async () =>
          runEcjFormexRefresh({
            ...options,
            writeDecision: async (input) => {
              await writer(input);
              throw new TypeError("Process killed before acknowledgment");
            },
          }),
        "Process killed before acknowledgment",
      );
      expect(writes).toHaveLength(1);
      expect(await Bun.file(options.resultsOut).text()).toBe("");
      const results = await runEcjFormexRefresh(options);
      expect(results.at(0)?.outcome).toBe("unchanged-already-current");
      expect(writes).toHaveLength(ids.length);
      expect(new Set(writes).size).toBe(ids.length);
      expect(
        (await Bun.file(options.resultsOut).text()).trim().split("\n"),
      ).toHaveLength(ids.length);
    });
  });

  test("writes through the real ingestion pipeline with fake object storage", async () => {
    const s3 = startFakeS3();
    try {
      await withFixture(async (options) => {
        const results = await runEcjFormexRefresh({
          ...options,
          writeDecision: processDecision,
        });
        expect(results.at(-1)?.outcome).toBe("refreshed");
        expect(s3.requests.some(({ method }) => method === "PUT")).toBe(true);
        expect(
          await runEcjFormexRefresh({
            ...options,
            writeDecision: processDecision,
          }),
        ).toEqual([]);
      });
    } finally {
      s3.stop();
    }
  });

  test("every input permutation has exactly one result per identity across batch sizes", async () => {
    await withFixture(async (options, { ids, directory }) => {
      for (let batchSize = 1; batchSize <= ids.length; batchSize += 1) {
        const permutation = [
          ...ids.slice(batchSize),
          ...ids.slice(0, batchSize),
        ].toReversed();
        await Bun.write(options.idsFile, permutation.join("\n"));
        const resultsOut = path.join(
          directory,
          `permutation-${batchSize}.jsonl`,
        );
        const results = await runEcjFormexRefresh({
          ...options,
          apply: false,
          batchSize,
          resultsOut,
        });
        expect(results.map(({ id }) => id)).toEqual(ids);
        const journal = (await Bun.file(resultsOut).text()).trim().split("\n");
        expect(journal).toHaveLength(ids.length);
        expect(new Set(results.map(({ id }) => id)).size).toBe(ids.length);
        expect(
          await runEcjFormexRefresh({
            ...options,
            apply: false,
            batchSize,
            resultsOut,
          }),
        ).toEqual([]);
      }
    });
  });

  test("an explicit row cursor accounts for skipped inputs without duplicate journal lines", async () => {
    await withFixture(async (options, { ids }) => {
      const after = ids.at(2);
      if (after === undefined) {
        throw new TypeError("Missing cursor fixture");
      }
      const results = await runEcjFormexRefresh({ ...options, after });
      expect(results.slice(0, 3).map(({ outcome }) => outcome)).toEqual(
        Array.from({ length: 3 }, () => "skipped-resume"),
      );
      expect(results.map(({ id }) => id)).toEqual(ids);
      expect(await runEcjFormexRefresh(options)).toEqual([]);
      expect(
        (await Bun.file(options.resultsOut).text()).trim().split("\n"),
      ).toHaveLength(ids.length);
    });
  });

  test("storage and publisher failures remain row outcomes and processing continues", async () => {
    await withFixture(async (options, { ids, directory, writes }) => {
      const storage = await runEcjFormexRefresh({
        ...options,
        readStoredRaw: async (key) =>
          Result.err(
            new StoredRawReadError({
              message: "Storage unavailable",
              key,
              cause: new TypeError("Fake S3 interruption"),
              permanent: false,
            }),
          ),
      });
      expect(storage).toHaveLength(ids.length);
      expect(
        storage.every(({ outcome }) => outcome === "retryable-exhausted"),
      ).toBe(true);
      const publisher = await runEcjFormexRefresh({
        ...options,
        resultsOut: path.join(directory, "publisher.jsonl"),
        refreshStoredFormex: async () => {
          throw new TypeError("Publisher interruption");
        },
      });
      expect(publisher).toHaveLength(ids.length);
      expect(
        publisher.every(({ outcome }) => outcome === "retryable-exhausted"),
      ).toBe(true);
      expect(writes).toHaveLength(0);
    });
  });

  test("a rejected pipeline write is never reported as refreshed", async () => {
    await withFixture(async (options, { directory }) => {
      for (const written of [
        { status: "complete", inserted: false, searchVectorFailed: false },
        { status: "retryable", inserted: false, reason: "source-raw-write" },
      ] as const) {
        const results = await runEcjFormexRefresh({
          ...options,
          resultsOut: path.join(directory, `${written.status}.jsonl`),
          writeDecision: async () => written,
        });
        expect(results.at(-1)?.outcome).toBe("write-rejected");
        expect(results.some(({ outcome }) => outcome === "refreshed")).toBe(
          false,
        );
      }
    });
  });

  test("overlapping apply runs share durable results without duplicate writes or lines", async () => {
    await withFixture(async (options, { ids, writes }) => {
      const concurrent = {
        ...options,
        batchSize: 1,
        leaseWaitMs: 5000,
        waitForLease: async () => {
          await Bun.sleep(1);
        },
        acquireBatch: async () => {
          const sourceLease = await acquireCaseLawSourceIngestionLease({
            scopedDb: options.ingestionDb,
            sourceId: options.sourceId,
          });
          return sourceLease === null
            ? null
            : {
                ingestionDb: options.ingestionDb,
                sourceLease,
                release: sourceLease.release,
              };
        },
      } satisfies RunnerOptions;
      const results = await Promise.all([
        runEcjFormexRefresh(concurrent),
        runEcjFormexRefresh(concurrent),
      ]);
      expect(results.flat()).toHaveLength(ids.length);
      expect(new Set(results.flat().map(({ id }) => id)).size).toBe(ids.length);
      expect(writes).toHaveLength(1);
      expect(
        (await Bun.file(options.resultsOut).text()).trim().split("\n"),
      ).toHaveLength(ids.length);
    });
  });

  test("waits for the scheduled lease holder within a bounded injected-clock budget", async () => {
    await withFixture(async (options) => {
      let time = 0;
      let attempts = 0;
      const acquire = options.acquireBatch;
      if (acquire === undefined) {
        throw new TypeError("Missing acquisition fixture");
      }
      const results = await runEcjFormexRefresh({
        ...options,
        leaseWaitMs: 60_000,
        now: () => time,
        waitForLease: async (milliseconds) => {
          time += milliseconds;
        },
        acquireBatch: async () => {
          attempts += 1;
          return attempts < 10 ? null : await acquire();
        },
      });
      expect(time).toBe(45_000);
      expect(results).toHaveLength(7);
      await expectFailure(
        async () =>
          runEcjFormexRefresh({
            ...options,
            resultsOut: `${options.resultsOut}.blocked`,
            leaseWaitMs: 10_000,
            now: () => time,
            waitForLease: async (milliseconds) => {
              time += milliseconds;
            },
            acquireBatch: async () => null,
          }),
        "Source ingestion lease is held",
      );
      expect(time).toBe(55_000);
    });
  });

  test("the first refusal releases the lease, leaves the blocked row unjournaled, and resumes it once", async () => {
    await withFixture(async (options, { ids, acquireBetween, writes }) => {
      const originalRefresh = options.refreshStoredFormex;
      if (originalRefresh === undefined) {
        throw new TypeError("Missing refresher");
      }
      const visits: string[] = [];
      const summary = await runRefresh({
        ...options,
        refreshStoredFormex: async (input) => {
          const identity = input.stored.sourceDocumentId ?? "";
          visits.push(identity);
          if (identity === "62020CJ0002:cs") {
            return {
              type: "rate-limited",
              publisherKey: "cellar-eu",
              status: 429,
              cooldownUntilEpochMs: 200_750,
            };
          }
          return await originalRefresh(input);
        },
      });
      expect(summary).toEqual({
        type: "rate-limited",
        results: [
          expect.objectContaining({ id: ids.at(0), outcome: "notice-missing" }),
        ],
        blockedId: ids.at(1),
        resumeAfter: ids.at(0),
        cooldownUntilEpochMs: 200_750,
      });
      expect(visits).toEqual(["62020CJ0001:cs", "62020CJ0002:cs"]);
      expect(writes).toEqual([]);
      await acquireBetween();
      const before = await Bun.file(options.resultsOut).text();
      expect(before.trim().split("\n")).toHaveLength(1);
      if (summary.type !== "rate-limited") {
        throw new TypeError("Expected a rate-limited summary");
      }
      const resumedVisits: string[] = [];
      const resumed = await runEcjFormexRefresh({
        ...options,
        after: summary.resumeAfter,
        refreshStoredFormex: async (input) => {
          resumedVisits.push(input.stored.sourceDocumentId ?? "");
          return await originalRefresh(input);
        },
      });
      expect(resumed.map(({ id }) => id)).toEqual(ids.slice(1));
      expect(resumedVisits.at(0)).toBe("62020CJ0002:cs");
      expect(resumedVisits).toHaveLength(ids.length - 1);
      expect(writes).toHaveLength(1);
      const after = await Bun.file(options.resultsOut).text();
      expect(after.startsWith(before)).toBe(true);
      const records = after
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map(({ id }) => id)).toEqual(ids);
      expect(records.every(({ attempt }) => attempt === 1)).toBe(true);
    });
  });

  for (const status of [429, 302]) {
    test(`a first-row refusal (${status}) stops after one request with no resume cursor`, async () => {
      await withFixture(async (options, { ids, acquireBetween }) => {
        let visits = 0;
        const summary = await runRefresh({
          ...options,
          refreshStoredFormex: async () => {
            visits += 1;
            return {
              type: "rate-limited",
              publisherKey: "cellar-eu",
              status,
              cooldownUntilEpochMs: 1,
            };
          },
        });
        expect(summary).toEqual({
          type: "rate-limited",
          results: [],
          blockedId: ids.at(0),
          resumeAfter: null,
          cooldownUntilEpochMs: 1,
        });
        expect(visits).toBe(1);
        expect(await Bun.file(options.resultsOut).text()).toBe("");
        await acquireBetween();
      });
    });
  }

  test("the real publisher refusal error stops after one request without a failed result", async () => {
    await withFixture(async (options, { ids, acquireBetween }) => {
      let visits = 0;
      const summary = await runRefresh({
        ...options,
        refreshStoredFormex: async ({ stored }) => {
          visits += 1;
          throw new PublisherRateLimitRefusalError({
            adapterKey: ADAPTER_KEYS.EU_ECJ,
            cursor: stored.sourceDocumentId,
            publisherKey: "cellar-eu",
            status: 429,
            cooldownUntilEpochMs: 1,
          });
        },
      });
      expect(summary).toEqual({
        type: "rate-limited",
        results: [],
        blockedId: ids.at(0),
        resumeAfter: null,
        cooldownUntilEpochMs: 1,
      });
      expect(visits).toBe(1);
      expect(await Bun.file(options.resultsOut).text()).toBe("");
      await acquireBetween();
    });
  });
}
