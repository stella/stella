import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  CORPUS_INDEX_MANIFESTS,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  corpusIndexCommitTimeoutSecs,
  corpusProjectionAppendIngestBudgetMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_REVISIONS,
  corpusProjectionOfflineBlockFits,
  corpusProjectionOfflineBlockJoins,
  type CorpusProjectionOfflineBuildPolicy,
  corpusProjectionOfflineIndexingWindowMs,
  corpusProjectionOfflineLeaseCanStart,
  corpusProjectionOfflineLoneKillJudgement,
  corpusProjectionOfflineNextShardClass,
  corpusProjectionOfflinePageLimit,
  corpusProjectionOfflineReserveToStartMs,
  corpusProjectionOfflineShardCapAfterKill,
  corpusProjectionOfflineShardClass,
  corpusProjectionOfflineShardIsClosed,
  corpusProjectionOfflineShardName,
  corpusProjectionOfflineStopReservingAtMs,
  planCorpusProjectionOfflineBuild,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import { openCorpusProjectionShardStaging } from "@/api/lib/legal-search/corpus-index-projection-offline-shard-file";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
  corpusProjectionOfflineIndexerEndedAt,
  corpusProjectionOfflineIndexerKillDeadline,
  corpusProjectionOfflineRequestLeaseFloor,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  CORPUS_PROJECTION_LEASE_MAX_MS,
  CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
} from "@/api/lib/legal-search/corpus-index-projection-store";

const MANIFESTS: CorpusIndexManifest[] = Object.values(CORPUS_INDEX_MANIFESTS);

const BASE_POLICY = {
  slots: 1,
  ingestBytesPerSecond:
    CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  maxShardBytes: CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  maxShardRevisions: CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_REVISIONS,
  fillWindowMs: 60_000,
  closeAllowanceMs: 30_000,
  proofAllowanceMs: 120_000,
  payloadReadConcurrency: 8,
  retryDelayMs: 60_000,
  payloadRetryLimit: 5,
} satisfies CorpusProjectionOfflineBuildPolicy;

/** The longest fill window a manifest's kill budget leaves inside a lease. */
const maxFillWindowMs = (
  manifest: CorpusIndexManifest,
  closeAllowanceMs: number,
) =>
  CORPUS_PROJECTION_LEASE_MAX_MS -
  corpusProjectionAppendIngestBudgetMs(manifest) -
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS -
  closeAllowanceMs;

/** The slowest rate that still indexes the largest revision in the window. */
const minIngestBytesPerSecond = (manifest: CorpusIndexManifest) =>
  Math.max(
    1_000_000,
    Math.ceil(
      (CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES * 1000) /
        corpusProjectionOfflineIndexingWindowMs(manifest),
    ),
  );

/** A valid policy for one registered manifest, every bound exercised. */
const manifestAndPolicy = fc
  .record({
    manifest: fc.constantFrom(...MANIFESTS),
    rateFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    maxShardBytes: fc.integer({
      min: CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
      max: 4 * 1024 ** 3,
    }),
    maxShardRevisions: fc.integer({
      min: 1,
      max: CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS,
    }),
    closeAllowanceMs: fc.integer({ min: 0, max: 60_000 }),
    fillFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    proofAllowanceMs: fc.integer({ min: 0, max: 30 * 60_000 }),
  })
  .map(({ manifest, fillFraction, rateFraction, ...rest }) => {
    const fillMax = maxFillWindowMs(manifest, rest.closeAllowanceMs);
    const rateMin = minIngestBytesPerSecond(manifest);
    return {
      manifest,
      policy: {
        ...BASE_POLICY,
        ...rest,
        ingestBytesPerSecond: Math.floor(
          rateMin + rateFraction * (1_000_000_000 - rateMin),
        ),
        fillWindowMs: Math.floor(10_000 + fillFraction * (fillMax - 10_000)),
      } satisfies CorpusProjectionOfflineBuildPolicy,
    };
  });

describe("offline build plan", () => {
  test("every registered generation leaves a fill window inside the longest lease", () => {
    for (const manifest of MANIFESTS) {
      expect(maxFillWindowMs(manifest, 30_000)).toBeGreaterThanOrEqual(
        BASE_POLICY.fillWindowMs,
      );
      expect(() =>
        planCorpusProjectionOfflineBuild(manifest, BASE_POLICY),
      ).not.toThrow();
    }
  });

  test("offline-build.deadlines", () => {
    assertProperty(
      "offline-build.deadlines",
      fc.property(
        manifestAndPolicy,
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 30 * 60_000 }),
        ({ manifest, policy }, reservedAtMs, deadlineSlackMs) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          const leaseExpiresAtMs = reservedAtMs + plan.leaseMs;
          expect(plan.leaseMs).toBeLessThanOrEqual(
            CORPUS_PROJECTION_LEASE_MAX_MS,
          );

          // A reservation that may still start is killed, and recorded, well
          // inside its lease: the run records it, not the sweep.
          const lastStartMs = leaseExpiresAtMs - plan.startMarginMs;
          expect(
            corpusProjectionOfflineLeaseCanStart(
              plan,
              leaseExpiresAtMs,
              lastStartMs,
            ),
          ).toBe(true);
          expect(
            corpusProjectionOfflineLeaseCanStart(
              plan,
              leaseExpiresAtMs,
              lastStartMs + 1,
            ),
          ).toBe(false);
          const killMs = corpusProjectionOfflineIndexerKillDeadline(
            new Date(lastStartMs),
            manifest,
          ).getTime();
          expect(
            killMs + CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
          ).toBeLessThanOrEqual(leaseExpiresAtMs);
          expect(killMs).toBe(
            lastStartMs + corpusProjectionAppendIngestBudgetMs(manifest),
          );
          // The store's own floor for a request first started then: a lease
          // the plan lets start is one the store starts, in every one of the
          // request's transactions, which share that first start.
          expect(
            corpusProjectionOfflineRequestLeaseFloor(
              new Date(lastStartMs),
              manifest,
            ).getTime(),
          ).toBeLessThanOrEqual(leaseExpiresAtMs);
          expect(
            corpusProjectionOfflineRequestLeaseFloor(
              new Date(lastStartMs + 1),
              manifest,
            ).getTime(),
          ).toBeGreaterThan(leaseExpiresAtMs);

          // A shard closes by the lease while every revision can still start
          // after the close allowance.
          const fill = {
            revisions: 1,
            limit: plan.shardRevisionCap,
            bytes: 0,
            earliestLeaseExpiresAtMs: leaseExpiresAtMs,
          };
          const closesAtMs = leaseExpiresAtMs - plan.closeMarginMs;
          expect(
            corpusProjectionOfflineShardIsClosed(plan, fill, closesAtMs),
          ).toBe(true);
          if (plan.shardRevisionCap > 1) {
            expect(
              corpusProjectionOfflineShardIsClosed(plan, fill, closesAtMs - 1),
            ).toBe(false);
          }
          expect(
            corpusProjectionOfflineLeaseCanStart(
              plan,
              leaseExpiresAtMs,
              closesAtMs + policy.closeAllowanceMs,
            ),
          ).toBe(true);

          // The last shard reserved before the stop point is killed, has
          // certainly ended, and leaves its proof the allowance, all before
          // the deadline.
          const deadlineMs =
            reservedAtMs + plan.stopReservingBeforeMs + deadlineSlackMs;
          const stopMs = corpusProjectionOfflineStopReservingAtMs(
            plan,
            deadlineMs,
          );
          const lastReservationMs = Math.min(
            stopMs,
            reservedAtMs + deadlineSlackMs,
          );
          const lastCloseMs = lastReservationMs + policy.fillWindowMs;
          const lastFirstStartMs = lastCloseMs + policy.closeAllowanceMs;
          const endedMs = corpusProjectionOfflineIndexerEndedAt(
            new Date(lastFirstStartMs),
            manifest,
          ).getTime();
          expect(endedMs + policy.proofAllowanceMs).toBeLessThanOrEqual(
            deadlineMs,
          );
          expect(endedMs).toBe(
            lastFirstStartMs +
              corpusProjectionAppendIngestBudgetMs(manifest) +
              CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
          );

          // Indexing a full shard at the measured rate fits the indexing
          // window, and the shard fits half the heap.
          const indexingMs =
            (plan.shardByteCap * 1000) / policy.ingestBytesPerSecond;
          expect(indexingMs).toBeLessThanOrEqual(plan.indexingWindowMs);
          expect(plan.shardByteCap).toBeLessThanOrEqual(policy.maxShardBytes);
          expect(plan.shardByteCap).toBeLessThanOrEqual(
            manifest.engine.indexConfig.indexing_settings.resources.heap_size /
              2,
          );
        },
      ),
    );
  });

  test("offline-build.shard-fill", () => {
    assertProperty(
      "offline-build.shard-fill",
      fc.property(
        manifestAndPolicy,
        fc.integer({ min: 1, max: CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS }),
        fc.array(fc.integer({ min: 1, max: 64 * 1024 ** 2 }), {
          minLength: 1,
          maxLength: 600,
        }),
        ({ manifest, policy }, limit, blockSizes) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          let revisions = 0;
          let bytes = 0;
          for (const size of blockSizes) {
            const fill = {
              revisions,
              bytes,
              limit,
              earliestLeaseExpiresAtMs: null,
            };
            if (!corpusProjectionOfflineBlockFits(plan, fill, size)) {
              break;
            }
            revisions += 1;
            bytes += size;
          }
          // A shard takes at least one block, never more than its class, the
          // run's shard size or the byte cap.
          expect(revisions).toBeGreaterThanOrEqual(1);
          expect(revisions).toBeLessThanOrEqual(
            Math.min(limit, plan.shardRevisionCap),
          );
          expect(bytes).toBeLessThanOrEqual(plan.shardByteCap);
        },
      ),
    );
  });

  /**
   * Request caps as a reservation reads them: none for a revision that never
   * failed, half of a request it was withdrawn from otherwise.
   */
  const requestCap = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constant(CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS),
    },
    {
      weight: 2,
      arbitrary: fc
        .integer({ min: 1, max: CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS })
        .map((withdrawnFrom) => Math.max(1, Math.floor(withdrawnFrom / 2))),
    },
    { weight: 1, arbitrary: fc.constant(1) },
  );

  test("offline-build.shard-class", () => {
    assertProperty(
      "offline-build.shard-class",
      fc.property(
        manifestAndPolicy,
        fc.array(requestCap, { minLength: 1, maxLength: 400 }),
        ({ manifest, policy }, caps) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          // Pack every block the way a run does: the next shard serves the
          // smallest waiting class and takes only blocks of that class.
          let waiting = caps.map((cap, index) => ({
            index,
            cap,
            shardClass: corpusProjectionOfflineShardClass(plan, cap),
          }));
          const shards: (typeof waiting)[] = [];
          while (waiting.length > 0) {
            const shardClass = corpusProjectionOfflineNextShardClass(
              plan,
              waiting.map((block) => block.shardClass),
            );
            const shard: typeof waiting = [];
            const left: typeof waiting = [];
            for (const block of waiting) {
              const joins = corpusProjectionOfflineBlockJoins(
                plan,
                {
                  revisions: shard.length,
                  bytes: shard.length,
                  limit: shardClass,
                  earliestLeaseExpiresAtMs: null,
                },
                { shardClass: block.shardClass, bytes: 1 },
              );
              if (joins) {
                shard.push(block);
              } else {
                left.push(block);
              }
            }
            expect(shard.length).toBeGreaterThan(0);
            shards.push(shard);
            waiting = left;
          }
          expect(
            shards
              .flat()
              .map(({ index }) => index)
              .toSorted((a, b) => a - b),
          ).toEqual(caps.map((_, index) => index));
          for (const shard of shards) {
            // One request per file, within every revision's cap.
            const smallest = Math.min(...shard.map(({ cap }) => cap));
            expect(shard.length).toBeLessThanOrEqual(smallest);
            expect(shard.length).toBeLessThanOrEqual(plan.shardRevisionCap);
            // A revision that may only start alone is alone, and a capped
            // revision never shares a file with one of another class.
            if (smallest === 1) {
              expect(shard.length).toBe(1);
            }
            expect(
              new Set(shard.map(({ shardClass }) => shardClass)).size,
            ).toBe(1);
          }
          // Smallest class first: no shard of a larger class precedes one of
          // a smaller class that was already waiting.
          const order = shards.map((shard) => shard[0]?.shardClass ?? 0);
          expect(order).toEqual(order.toSorted((a, b) => a - b));
        },
      ),
    );
  });

  /**
   * The run's time, from the store's constants: from reserving to the first
   * start a shard has at most the longest lease less the kill budget and the
   * record margin; after the first start, the start window for the later
   * start transactions, then the indexing window, and as much again for the
   * file, the spawn, the merges at exit and the publish, all inside the kill
   * budget a REST ingest of the generation gets.
   */
  test("offline-build.request-sizing", () => {
    for (const manifest of MANIFESTS) {
      const killBudgetMs = corpusProjectionAppendIngestBudgetMs(manifest);
      const indexingWindowMs =
        corpusProjectionOfflineIndexingWindowMs(manifest);
      expect(
        CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS + 2 * indexingWindowMs,
      ).toBeLessThanOrEqual(killBudgetMs);
      expect(indexingWindowMs).toBeLessThanOrEqual(
        corpusIndexCommitTimeoutSecs(manifest) * 1000,
      );
      expect(corpusProjectionOfflineReserveToStartMs(manifest)).toBe(
        CORPUS_PROJECTION_LEASE_MAX_MS -
          killBudgetMs -
          CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
      );
    }
    // The figures the module comment quotes, for a 600 s commit window.
    const v10 = CORPUS_INDEX_MANIFESTS.case_law_v10;
    expect(corpusIndexCommitTimeoutSecs(v10)).toBe(600);
    expect(corpusProjectionAppendIngestBudgetMs(v10)).toBe(660_000);
    expect(corpusProjectionOfflineReserveToStartMs(v10)).toBe(180_000);
    expect(corpusProjectionOfflineIndexingWindowMs(v10)).toBe(300_000);

    assertProperty(
      "offline-build.request-sizing",
      fc.property(
        manifestAndPolicy,
        fc.array(
          fc.integer({
            min: 1,
            max: CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
          }),
          { minLength: 1, maxLength: 300 },
        ),
        ({ manifest, policy }, blockSizes) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          expect(plan.shardByteCap).toBeGreaterThanOrEqual(
            CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
          );
          expect(plan.reserveToFirstStartMs).toBeLessThanOrEqual(
            corpusProjectionOfflineReserveToStartMs(manifest),
          );
          expect(plan.startTransactionsPerShard).toBe(
            Math.ceil(
              plan.shardRevisionCap / CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
            ),
          );
          expect(plan.startTransactionsPerShard).toBeLessThanOrEqual(
            CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS /
              CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
          );
          // Pack every block in order, a new shard whenever the next does not
          // fit: an oversized request is split, every block lands in exactly
          // one shard, and every shard indexes inside its window.
          const shards: number[][] = [[]];
          for (const size of blockSizes) {
            const current = shards.at(-1) ?? [];
            const fill = {
              revisions: current.length,
              bytes: current.reduce((sum, bytes) => sum + bytes, 0),
              limit: plan.shardRevisionCap,
              earliestLeaseExpiresAtMs: null,
            };
            if (corpusProjectionOfflineBlockFits(plan, fill, size)) {
              current.push(size);
            } else {
              expect(current.length).toBeGreaterThan(0);
              shards.push([size]);
            }
          }
          expect(shards.flat()).toEqual(blockSizes);
          for (const shard of shards) {
            const bytes = shard.reduce((sum, size) => sum + size, 0);
            expect(shard.length).toBeLessThanOrEqual(plan.shardRevisionCap);
            expect(bytes).toBeLessThanOrEqual(plan.shardByteCap);
            expect(
              (bytes * 1000) / policy.ingestBytesPerSecond,
            ).toBeLessThanOrEqual(plan.indexingWindowMs);
          }
        },
      ),
    );
  });

  test("a request that cannot index inside its window is refused, never sent", () => {
    const v2 = CORPUS_INDEX_MANIFESTS.legislation_v2;
    // A 60 s commit window leaves 30 s of indexing: too little for the
    // largest revision at 4 MB/s.
    expect(corpusProjectionOfflineIndexingWindowMs(v2)).toBe(30_000);
    expect(() =>
      planCorpusProjectionOfflineBuild(v2, {
        ...BASE_POLICY,
        ingestBytesPerSecond: 4_000_000,
      }),
    ).toThrow("cannot index the largest revision");
    expect(() =>
      planCorpusProjectionOfflineBuild(v2, {
        ...BASE_POLICY,
        maxShardBytes: CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES - 1,
      }),
    ).toThrow("shard byte limit must be an integer");
    // A block over the cap is refused, not shipped alone past the window.
    const plan = planCorpusProjectionOfflineBuild(v2, BASE_POLICY);
    expect(() =>
      corpusProjectionOfflineBlockFits(
        plan,
        {
          revisions: 0,
          bytes: 0,
          limit: plan.shardRevisionCap,
          earliestLeaseExpiresAtMs: null,
        },
        plan.shardByteCap + 1,
      ),
    ).toThrow("exceeds the shard byte cap");
  });

  /**
   * The cap's feedback loop against an indexer of a fixed true rate: a shard
   * is killed when indexing it takes longer than the run time the start
   * window leaves, and each kill halves the cap. For any true rate the plan
   * accepts, the cap settles on shards that fit after at most log2(cap /
   * largest revision) + 1 kills, never below the largest revision, and every
   * later shard delivers at least the largest revision's bytes. Below the
   * slowest accepted rate the loop ends typed, in as few kills.
   */
  test("offline-build.cap-feedback", () => {
    assertProperty(
      "offline-build.cap-feedback",
      fc.property(
        manifestAndPolicy,
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ manifest, policy }, rateFraction) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          const runMs =
            corpusProjectionAppendIngestBudgetMs(manifest) -
            CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS;
          const slowestAccepted = minIngestBytesPerSecond(manifest);
          // Rates from a tenth of the slowest accepted one to the policy's.
          const trueRate =
            slowestAccepted / 10 +
            rateFraction * (policy.ingestBytesPerSecond - slowestAccepted / 10);
          const killedBy = (bytes: number) => (bytes * 1000) / trueRate > runMs;
          const maxKills =
            Math.ceil(
              Math.log2(
                plan.shardByteCap / CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
              ),
            ) + 1;
          let cap = plan.shardByteCap;
          let kills = 0;
          let stopped = false;
          for (let shard = 0; shard < 64 && !stopped; shard += 1) {
            if (!killedBy(cap)) {
              continue;
            }
            kills += 1;
            const next = corpusProjectionOfflineShardCapAfterKill(cap, cap);
            if (next.type === "rate_too_slow") {
              stopped = true;
            } else {
              cap = next.shardByteCap;
            }
          }
          expect(kills).toBeLessThanOrEqual(maxKills);
          if (trueRate >= slowestAccepted) {
            // Accepted rates converge and keep making progress.
            expect(stopped).toBe(false);
            expect(killedBy(cap)).toBe(false);
            expect(cap).toBeGreaterThanOrEqual(
              CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
            );
          } else {
            // Below it the run either settles or stops typed, never loops.
            expect(stopped || !killedBy(cap)).toBe(true);
          }
        },
      ),
    );
  });

  test("offline-build.lone-kill-judgement", () => {
    const plan = { indexingWindowMs: 300_000 };
    const judge = (
      ingested: { bytes: number; ms: number }[],
      bytes: number,
      killAfterMs: number,
    ) =>
      corpusProjectionOfflineLoneKillJudgement(plan, {
        ingested,
        bytes,
        killAfterMs,
      });
    // Handed less than the window: the kill says nothing about the revision.
    expect(judge([], 1_000_000, 299_999)).toBe("budget_short");
    // A full window and nothing comparable measured: the revision's fault.
    expect(judge([], 1_000_000, 600_000)).toBe("revision");
    // Fast-failing or small shards are no evidence either way.
    expect(
      judge([{ bytes: 999_999, ms: 600_000_000 }], 1_000_000, 600_000),
    ).toBe("revision");
    // 2 MB ingested in 400 s: 3 MB in a 600 s budget, so 3 MB fits.
    const slow = [{ bytes: 2_000_000, ms: 400_000 }];
    expect(judge(slow, 2_000_000, 600_000)).toBe("revision");
    // A budget of 300 s indexes 1.5 MB at that rate: a 2 MB kill is the
    // engine's.
    expect(judge(slow, 2_000_000, 300_000)).toBe("rate_too_slow");

    const shard = fc.record({
      bytes: fc.integer({ min: 1, max: 2 ** 24 }),
      ms: fc.integer({ min: 0, max: 60 * 60_000 }),
    });
    assertProperty(
      "offline-build.lone-kill-judgement",
      fc.property(
        fc.array(shard, { maxLength: 8 }),
        fc.array(shard, { maxLength: 8 }),
        fc.integer({ min: 1, max: 2 ** 24 }),
        fc.integer({ min: 1, max: 60 * 60_000 }),
        fc.integer({ min: 1, max: 4 }),
        (ingested, others, bytes, killAfterMs, speedUp) => {
          const verdict = judge(ingested, bytes, killAfterMs);
          if (killAfterMs < plan.indexingWindowMs) {
            expect(verdict).toBe("budget_short");
            return;
          }
          // Shards smaller than the judged revision never move the verdict.
          const smaller = others.map((other) => ({
            ...other,
            bytes: Math.max(1, Math.min(other.bytes, bytes - 1)),
          }));
          expect(
            judge(
              [...ingested, ...smaller.filter((other) => other.bytes < bytes)],
              bytes,
              killAfterMs,
            ),
          ).toBe(verdict);
          const comparable = ingested.filter((other) => other.bytes >= bytes);
          if (comparable.every((other) => other.ms === 0)) {
            expect(verdict).toBe("revision");
          }
          // The engine is blamed only on evidence that, at the comparable
          // shards' combined rate, the budget indexes fewer bytes than the
          // revision holds.
          const comparableBytes = comparable.reduce(
            (sum, other) => sum + BigInt(other.bytes),
            0n,
          );
          const comparableMs = comparable.reduce(
            (sum, other) => sum + BigInt(other.ms),
            0n,
          );
          expect(verdict === "rate_too_slow").toBe(
            comparableMs > 0n &&
              comparableBytes * BigInt(killAfterMs) <
                BigInt(bytes) * comparableMs,
          );
          // A faster engine, or a longer budget, never shifts the blame from
          // the revision to the engine.
          if (verdict === "revision") {
            expect(
              judge(
                ingested.map((other) => ({
                  ...other,
                  ms: Math.floor(other.ms / speedUp),
                })),
                bytes,
                killAfterMs,
              ),
            ).toBe("revision");
            expect(judge(ingested, bytes, killAfterMs * speedUp)).toBe(
              "revision",
            );
          }
        },
      ),
    );
  });

  test("offline-build.page-bytes", () => {
    assertProperty(
      "offline-build.page-bytes",
      fc.property(
        manifestAndPolicy,
        fc.integer({ min: 1, max: CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS }),
        fc.option(
          fc.integer({
            min: 1,
            max: CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
          }),
          { nil: null },
        ),
        ({ manifest, policy }, remainingRevisions, averageBlockBytes) => {
          const plan = planCorpusProjectionOfflineBuild(manifest, policy);
          const limit = corpusProjectionOfflinePageLimit(plan, {
            remainingRevisions,
            averageBlockBytes,
          });
          expect(limit).toBeGreaterThanOrEqual(1);
          expect(limit).toBeLessThanOrEqual(
            Math.min(
              CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
              remainingRevisions,
            ),
          );
          // A page of average blocks holds at most one shard of bytes, or
          // one block when a single one is that large.
          if (averageBlockBytes !== null && limit > 1) {
            expect(limit * averageBlockBytes).toBeLessThanOrEqual(
              plan.shardByteCap,
            );
          }
        },
      ),
    );
  });

  test("a policy outside its bounds is refused", () => {
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v10;
    const refused: [Partial<CorpusProjectionOfflineBuildPolicy>, string][] = [
      [{ slots: 0 }, "slot count"],
      [{ slots: 9 }, "slot count"],
      [{ ingestBytesPerSecond: 1_000_000 - 1 }, "ingest rate"],
      [{ maxShardBytes: 1024 }, "shard byte limit"],
      [{ maxShardRevisions: 0 }, "shard revision limit"],
      [
        { maxShardRevisions: CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS + 1 },
        "shard revision limit",
      ],
      [{ fillWindowMs: 10_000 - 1 }, "fill window"],
      [
        {
          fillWindowMs:
            maxFillWindowMs(manifest, BASE_POLICY.closeAllowanceMs) + 1,
        },
        "fill window",
      ],
      [{ proofAllowanceMs: -1 }, "proof allowance"],
    ];
    for (const [change, field] of refused) {
      expect(() =>
        planCorpusProjectionOfflineBuild(manifest, {
          ...BASE_POLICY,
          ...change,
        }),
      ).toThrow(`Offline projection build ${field} must be an integer`);
    }
  });

  test("a shard name is unique per shard and safe for the job contract", () => {
    const first = corpusProjectionOfflineShardName("run-1", Bun.randomUUIDv7());
    const second = corpusProjectionOfflineShardName(
      "run-1",
      Bun.randomUUIDv7(),
    );
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(() => corpusProjectionOfflineShardName("../up", "x")).toThrow(
      "run id must be",
    );
    expect(() => corpusProjectionOfflineShardName(".hidden", "x")).toThrow(
      "run id must be",
    );
    expect(() => corpusProjectionOfflineShardName("run", "a/b")).toThrow(
      "shard name is invalid",
    );
  });
});

describe("offline shard file", () => {
  /** A block as the builder writes it: one line per document. */
  const block = (revision: string, documents: number) =>
    Array.from(
      { length: documents },
      (_, index) =>
        `${JSON.stringify({ projection_revision: revision, document_id: `${revision}:${index}`, body: "ž".repeat(index) })}\n`,
    ).join("");

  test("offline-build.assembly", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "offline-shard-"));
    try {
      let serial = 0;
      await assertProperty(
        "offline-build.assembly",
        fc.asyncProperty(
          fc.array(
            fc.record({
              documents: fc.integer({ min: 1, max: 4 }),
              started: fc.boolean(),
            }),
            { minLength: 1, maxLength: 24 },
          ),
          async (blocks) => {
            serial += 1;
            const shardDirectory = path.join(directory, String(serial));
            await mkdir(shardDirectory);
            const staging = await openCorpusProjectionShardStaging(
              shardDirectory,
              `shard.${serial}`,
            );
            const written = [];
            for (const [index, { documents, started }] of blocks.entries()) {
              const revision = `rev-${serial}-${index}`;
              const text = block(revision, documents);
              const range = await staging.append(text);
              written.push({ revision, text, range, started });
            }
            const started = written.filter((entry) => entry.started);
            if (started.length === 0) {
              await staging.discard();
              expect(await readdir(shardDirectory)).toEqual([]);
              return;
            }
            const file = await staging.finish(
              started.map(({ range }) => range),
            );
            const content = await readFile(file.path, "utf-8");
            // Exactly the started blocks, in build order, and no line of a
            // revision that did not start.
            expect(content).toBe(started.map(({ text }) => text).join(""));
            const startedIds = new Set(started.map(({ revision }) => revision));
            for (const line of content.trimEnd().split("\n")) {
              const parsed: unknown = JSON.parse(line);
              const revision =
                typeof parsed === "object" && parsed !== null
                  ? Reflect.get(parsed, "projection_revision")
                  : undefined;
              expect(startedIds.has(String(revision))).toBe(true);
            }
            expect(file.bytes).toBe(Buffer.byteLength(content, "utf-8"));
            // The staging file is gone; only the finished file remains.
            expect(await readdir(shardDirectory)).toEqual([
              path.basename(file.path),
            ]);
          },
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a shard name that already has a file is refused", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "offline-shard-"));
    try {
      const first = await openCorpusProjectionShardStaging(directory, "same");
      await first.append(block("a", 1));
      expect(
        await rejectionOf(openCorpusProjectionShardStaging(directory, "same")),
      ).toMatchObject({ code: "EEXIST" });
      await first.discard();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
