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
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
  corpusIndexCommitTimeoutSecs,
  corpusProjectionAppendIngestBudgetMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_REVISIONS,
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
  corpusProjectionOfflineBlockFits,
  corpusProjectionOfflineBlockJoins,
  type CorpusProjectionOfflineBuildPolicy,
  corpusProjectionOfflineLeaseCanStart,
  corpusProjectionOfflineNextShardClass,
  corpusProjectionOfflineShardClass,
  corpusProjectionOfflineShardIsClosed,
  corpusProjectionOfflineShardName,
  corpusProjectionOfflineStopReservingAtMs,
  planCorpusProjectionOfflineBuild,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import { openCorpusProjectionShardStaging } from "@/api/lib/legal-search/corpus-index-projection-offline-shard-file";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  corpusProjectionOfflineIndexerEndedAt,
  corpusProjectionOfflineIndexerKillDeadline,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import { CORPUS_PROJECTION_LEASE_MAX_MS } from "@/api/lib/legal-search/corpus-index-projection-store";

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
  maxConsecutiveDeliveryFailures: 3,
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

/** A valid policy for one registered manifest, every bound exercised. */
const manifestAndPolicy = fc
  .record({
    manifest: fc.constantFrom(...MANIFESTS),
    ingestBytesPerSecond: fc.integer({ min: 1_000_000, max: 1_000_000_000 }),
    maxShardBytes: fc.integer({ min: 1024 ** 2, max: 4 * 1024 ** 3 }),
    maxShardRevisions: fc.integer({
      min: 1,
      max: CORPUS_PROJECTION_APPEND_MAX_REVISIONS,
    }),
    closeAllowanceMs: fc.integer({ min: 0, max: 60_000 }),
    fillFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    proofAllowanceMs: fc.integer({ min: 0, max: 30 * 60_000 }),
  })
  .map(({ manifest, fillFraction, ...rest }) => {
    const fillMax = maxFillWindowMs(manifest, rest.closeAllowanceMs);
    return {
      manifest,
      policy: {
        ...BASE_POLICY,
        ...rest,
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

          // Indexing a full shard at the measured rate fits half the kill
          // budget and one commit window, and the shard fits half the heap.
          const indexingMs =
            (plan.shardByteCap * 1000) / policy.ingestBytesPerSecond;
          expect(indexingMs).toBeLessThanOrEqual(
            corpusProjectionAppendIngestBudgetMs(manifest) / 2,
          );
          expect(indexingMs).toBeLessThanOrEqual(
            corpusIndexCommitTimeoutSecs(manifest) * 1000,
          );
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
        fc.integer({ min: 1, max: CORPUS_PROJECTION_APPEND_MAX_REVISIONS }),
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
          // A shard takes at least one block, never more than its class or
          // the run's shard size, and only a lone block may exceed the byte
          // cap.
          expect(revisions).toBeGreaterThanOrEqual(1);
          expect(revisions).toBeLessThanOrEqual(
            Math.min(limit, plan.shardRevisionCap),
          );
          if (revisions > 1) {
            expect(bytes).toBeLessThanOrEqual(plan.shardByteCap);
          }
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
      arbitrary: fc.constant(CORPUS_PROJECTION_APPEND_MAX_REVISIONS),
    },
    {
      weight: 2,
      arbitrary: fc
        .integer({ min: 1, max: CORPUS_PROJECTION_APPEND_MAX_REVISIONS })
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

  test("a policy outside its bounds is refused", () => {
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v10;
    const refused: [Partial<CorpusProjectionOfflineBuildPolicy>, string][] = [
      [{ slots: 0 }, "slot count"],
      [{ slots: 9 }, "slot count"],
      [{ ingestBytesPerSecond: 1_000_000 - 1 }, "ingest rate"],
      [{ maxShardBytes: 1024 }, "shard byte limit"],
      [{ maxShardRevisions: 0 }, "shard revision limit"],
      [
        { maxShardRevisions: CORPUS_PROJECTION_APPEND_MAX_REVISIONS + 1 },
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
      [
        { maxConsecutiveDeliveryFailures: 0 },
        "consecutive delivery failure limit",
      ],
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
