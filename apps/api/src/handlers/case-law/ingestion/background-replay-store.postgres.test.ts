import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import type { Verdict } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { DAY_IN_MS } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawReplayAuditEvents,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  caseLawReplayReportedDecisions,
  caseLawReplaySourceProgress,
  caseLawSources,
  databaseBackfillStates,
  systemAuditRuns,
} from "@/api/db/schema";
import {
  EMPTY_AST,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  getAdapter,
  listAdapters,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplaySource,
} from "@/api/handlers/case-law/ingestion/background-replay";
import { createBackgroundReplayRunner } from "@/api/handlers/case-law/ingestion/background-replay-runner";
import {
  buildReplayRetirementQuery,
  createBackgroundReplayStore,
} from "@/api/handlers/case-law/ingestion/background-replay-store";
import {
  buildBackgroundReplayProbe,
  buildReplayPageQuery,
  buildReplayScopeEndQuery,
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  type ReplayRowReport,
  selectScopeEnd,
} from "@/api/handlers/case-law/ingestion/replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  splitStoredDecisionTextMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { buildCaseLawReplayCompactionQuery } from "@/api/lib/db/aggregate-lock";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import {
  scaleTableToProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "@/api/tests/query-plans/scale-profile";

import { REPLAY_PREVIEW_FAILURE, replayFailure } from "./replay-failure";

/** A replayed raw key is reported only when the reserved batch has one. */
const replayedKeyOf = (key: string | null) =>
  key === null ? {} : { replayedSourceRawS3Key: key };

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const verdict = () => ({ kind: "normal", signals: [] }) satisfies Verdict;

if (!databaseUrl || !enabled) {
  describe.skip("durable background replay reservations", () => {
    test("requires an explicitly enabled Postgres database", () =>
      expect(enabled && Boolean(databaseUrl)).toBe(false));
  });
} else {
  describe("durable background replay reservations", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(callback);
    const sources: BackgroundReplaySource[] = [];
    cleanUp(async () => {
      for (const source of sources) {
        await db
          .delete(caseLawReplayReportedDecisions)
          .where(eq(caseLawReplayReportedDecisions.sourceId, source.id));
        await db
          .delete(caseLawReplayAuditEvents)
          .where(eq(caseLawReplayAuditEvents.sourceId, source.id));
        await db
          .delete(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id));
        await db
          .delete(databaseBackfillStates)
          .where(
            eq(
              databaseBackfillStates.name,
              `case-law-replay:${source.id}:${source.currentParserVersion}:dry-run`,
            ),
          );
        await db
          .delete(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id));
        await db
          .delete(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id));
        await db
          .delete(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id));
        await db
          .delete(databaseBackfillStates)
          .where(
            eq(
              databaseBackfillStates.name,
              `case-law-replay:${source.id}:${source.currentParserVersion}`,
            ),
          );
        await db.delete(caseLawSources).where(eq(caseLawSources.id, source.id));
      }
    });
    const fixture = async () => {
      const source = {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        currentParserVersion: 2,
        mode: "enrolled",
        rowsBehind: 3,
      } as const satisfies BackgroundReplaySource;
      sources.push(source);
      await db.insert(caseLawSources).values({
        id: source.id,
        adapterKey: `store-${source.id}`,
        name: "replay store fixture",
      });
      const sortedIds = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted(compareCodeUnit);
      const [firstId, secondId, thirdId] = sortedIds;
      if (
        firstId === undefined ||
        secondId === undefined ||
        thirdId === undefined
      ) {
        panic("Expected three replay fixture decision ids");
      }
      const ids = [firstId, secondId, thirdId] as const;
      await db.insert(caseLawDecisions).values(
        ids.map((id, index) => ({
          id,
          sourceId: source.id,
          caseNumber: `store-${index}`,
          court: "fixture court",
          country: "CZE",
          language: "cs",
          parserVersion: 1,
          sourceHash: "a".repeat(64),
          sourceHashVersion: 1,
          sourceRawS3Key: rawSourcePayloadKey({
            owner: {
              family: RAW_SOURCE_FAMILY.CASE_LAW,
              sourceId: source.id,
              documentId: id,
            },
            data: "<html>stored decision</html>",
          }),
        })),
      );
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
      });
      return { source, ids, store };
    };
    const applied = (batch: BackgroundReplayBatch) => ({
      report: {
        id: batch.decisionId,
        caseNumber: "fixture",
        language: "cs",
        outcome: REPLAY_ROW_OUTCOME.APPLIED,
        ...replayedKeyOf(batch.sourceRawS3Key),
      },
      durationMs: 4,
      verdict: verdict(),
    });

    // Simulates the canonical writer's payload-first, metadata-last transaction.
    const persistParsedFixture = async (batch: BackgroundReplayBatch) =>
      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ parserVersion: batch.targetParserVersion })
          .where(eq(caseLawDecisions.id, batch.decisionId));
        await tx
          .update(caseLawDecisions)
          .set({
            parsedSourceHash: caseLawDecisions.sourceHash,
            parsedSourceHashVersion: caseLawDecisions.sourceHashVersion,
            parsedSourceRawS3Key: caseLawDecisions.sourceRawS3Key,
            updatedAt: caseLawDecisions.updatedAt,
          })
          .where(eq(caseLawDecisions.id, batch.decisionId));
      });

    test("dry-run diff manifests are bounded, retryable, versioned and reset explicitly", async () => {
      const { source: enrolled, store } = await fixture();
      const source = { ...enrolled, mode: "dry-run" } as const;
      const ids = Array.from({ length: 21 }, () =>
        createSafeId<"caseLawDecision">(),
      );
      for (const decisionId of ids.slice(0, 20)) {
        expect(await store.needsDryRunDiffSample(source, decisionId)).toBe(
          true,
        );
        await store.recordDryRunDiffSample(source, {
          decisionId,
          key: `fixture/diff/${decisionId}`,
        });
      }
      const overflow = ids[20];
      const existing = ids[0];
      if (!overflow || !existing) {
        panic("Expected sample manifest fixtures");
      }
      expect(await store.needsDryRunDiffSample(source, overflow)).toBe(false);
      expect(await store.needsDryRunDiffSample(source, existing)).toBe(false);
      await store.recordDryRunDiffSample(source, {
        decisionId: overflow,
        key: "fixture/overflow",
      });
      await store.recordDryRunDiffSample(source, {
        decisionId: existing,
        key: "fixture/replacement-must-not-overwrite-review",
      });
      const manifest = (
        await db
          .select()
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
      ).at(0);
      expect(manifest?.dryRunDiffSamples).toHaveLength(20);
      expect(
        manifest?.dryRunDiffSamples.find(
          (sample) => sample.decisionId === existing,
        )?.key,
      ).toBe(`fixture/diff/${existing}`);
      expect(
        await store.needsDryRunDiffSample(
          { ...source, currentParserVersion: source.currentParserVersion + 1 },
          overflow,
        ),
      ).toBe(true);
      const newerSource = {
        ...source,
        currentParserVersion: source.currentParserVersion + 1,
      };
      await store.recordDryRunDiffSample(newerSource, {
        decisionId: overflow,
        key: "fixture/new-parser",
      });
      expect(await store.needsDryRunDiffSample(source, existing)).toBe(false);
      await store.resetDryRunCursor(source);
      expect(
        (
          await db
            .select()
            .from(caseLawReplaySourceProgress)
            .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
        ).at(0)?.dryRunDiffSamples,
      ).toEqual([{ decisionId: overflow, key: "fixture/new-parser" }]);
      await store.resetDryRunCursor(newerSource);
      expect(await store.needsDryRunDiffSample(newerSource, overflow)).toBe(
        true,
      );
      expect(
        (
          await db
            .select()
            .from(caseLawReplaySourceProgress)
            .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
        ).at(0)?.dryRunDiffSamples,
      ).toEqual([]);
    });

    test("reported rows precede parser waves and completed waves precede only remaining work", async () => {
      const setups = await Promise.all([fixture(), fixture(), fixture()]);
      const [reportedSetup, bumpedSetup, remainingSetup] = setups;
      if (!reportedSetup || !bumpedSetup || !remainingSetup) {
        panic("Expected all priority fixtures");
      }
      const makeSource = async (
        setup: typeof reportedSetup,
        adapterKey:
          | typeof ADAPTER_KEYS.EU_ECJ
          | typeof ADAPTER_KEYS.CZ_NSS
          | typeof ADAPTER_KEYS.SK_COURTS,
      ) => {
        await db
          .update(caseLawSources)
          .set({ adapterKey })
          .where(eq(caseLawSources.id, setup.source.id));
        const source = {
          ...setup.source,
          adapterKey,
          currentParserVersion: PARSER_VERSIONS[adapterKey],
        };
        sources.push(source);
        return source;
      };
      const reported = await makeSource(reportedSetup, ADAPTER_KEYS.EU_ECJ);
      const bumped = await makeSource(bumpedSetup, ADAPTER_KEYS.CZ_NSS);
      const remaining = await makeSource(
        remainingSetup,
        ADAPTER_KEYS.SK_COURTS,
      );
      await db.insert(caseLawReplaySourceProgress).values([
        {
          sourceId: reported.id,
          lastFullReplayParserVersion: reported.currentParserVersion,
        },
        {
          sourceId: remaining.id,
          lastFullReplayParserVersion: remaining.currentParserVersion,
        },
      ]);
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: { mode: "enrolled", reviewedDryRun: "fixture" },
        [ADAPTER_KEYS.CZ_NSS]: { mode: "enrolled", reviewedDryRun: "fixture" },
        [ADAPTER_KEYS.SK_COURTS]: {
          mode: "enrolled",
          reviewedDryRun: "fixture",
        },
      } as const;
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        sourceEnabled: (key) =>
          [
            ADAPTER_KEYS.EU_ECJ,
            ADAPTER_KEYS.CZ_NSS,
            ADAPTER_KEYS.SK_COURTS,
          ].some((allowed) => key === allowed),
      });
      const reportedId = reportedSetup.ids[2];
      expect(
        await store.enqueueReportedDecision({
          sourceId: reported.id,
          decisionId: reportedId,
          targetParserVersion: reported.currentParserVersion,
        }),
      ).toEqual({ type: "queued" });
      expect(
        await store.enqueueReportedDecision({
          sourceId: bumped.id,
          decisionId: reportedId,
          targetParserVersion: bumped.currentParserVersion,
        }),
      ).toEqual({ type: "unavailable" });
      await db
        .update(caseLawDecisions)
        .set({
          parserVersion: reported.currentParserVersion,
          parsedSourceHash: caseLawDecisions.sourceHash,
          parsedSourceHashVersion: caseLawDecisions.sourceHashVersion,
          parsedSourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        })
        .where(eq(caseLawDecisions.id, reportedId));
      expect((await store.chooseSource())?.id).toBe(bumped.id);
      await db
        .update(caseLawDecisions)
        .set({ parsedSourceRawS3Key: null })
        .where(eq(caseLawDecisions.id, reportedId));
      expect((await store.chooseSource())?.id).toBe(reported.id);
      const reservation = await store.reserveBatch(
        reported,
        "2026-10-01",
        verdict(),
      );
      if (reservation.type !== "reserved") {
        panic("Expected reported replay reservation");
      }
      expect(reservation.batch.decisionId).toBe(reportedId);
      await persistParsedFixture(reservation.batch);
      expect(
        await store.completeBatch(
          reservation.batch,
          applied(reservation.batch),
        ),
      ).toBe("applied");
      const queued = await db
        .select()
        .from(caseLawReplayReportedDecisions)
        .where(eq(caseLawReplayReportedDecisions.sourceId, reported.id));
      expect(queued).toHaveLength(1);
      expect(queued.at(0)?.completedAt).not.toBeNull();
      const removedId = reportedSetup.ids[0];
      expect(
        await store.enqueueReportedDecision({
          sourceId: reported.id,
          decisionId: removedId,
          targetParserVersion: reported.currentParserVersion,
        }),
      ).toEqual({ type: "queued" });
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, removedId));
      expect((await store.chooseSource())?.id).toBe(bumped.id);
      // Emptying the wave records completion only after every reserved row is terminal.
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: bumped.currentParserVersion + 1 })
        .where(eq(caseLawDecisions.sourceId, bumped.id));
      expect((await store.chooseSource())?.id).toBe(remaining.id);
      expect(
        (
          await db
            .select()
            .from(caseLawReplaySourceProgress)
            .where(eq(caseLawReplaySourceProgress.sourceId, bumped.id))
        ).at(0)?.lastFullReplayParserVersion,
      ).toBe(bumped.currentParserVersion);
    });

    test("restored raw input readmits old writers without downgrading newer parsers", async () => {
      for (const parserVersion of [null, 1, 2, 3]) {
        const { source, ids, store } = await fixture();
        for (const id of ids.slice(1)) {
          await db
            .update(caseLawDecisions)
            .set({ parserVersion: 3 })
            .where(eq(caseLawDecisions.id, id));
        }
        const first = await store.reserveBatch(source, "2026-10-01", verdict());
        if (first.type !== "reserved" || first.batch.sourceRawS3Key === null) {
          throw new TypeError("Expected the first immutable input reservation");
        }
        const originalKey = first.batch.sourceRawS3Key;
        const replacementKey = rawSourcePayloadKey({
          owner: {
            family: RAW_SOURCE_FAMILY.CASE_LAW,
            sourceId: source.id,
            documentId: first.batch.decisionId,
          },
          data: "<html>replacement decision</html>",
        });
        expect(replacementKey).not.toBe(originalKey);
        await db
          .update(caseLawDecisions)
          .set({
            sourceRawS3Key: replacementKey,
            sourceObservationOrder: sql`coalesce(${caseLawDecisions.sourceObservationOrder}, 0) + 1`,
          })
          .where(eq(caseLawDecisions.id, first.batch.decisionId));
        expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
          type: "empty",
        });
        expect(
          (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.id, first.batch.id))
          ).at(0),
        ).toMatchObject({
          status: "superseded",
          outcome: null,
          applied: 0,
          blocked: 0,
          readmissions: 0,
        });
        await db
          .update(caseLawDecisions)
          .set({
            sourceRawS3Key: originalKey,
            parserVersion,
            sourceObservationOrder: sql`coalesce(${caseLawDecisions.sourceObservationOrder}, 0) + 1`,
          })
          .where(eq(caseLawDecisions.id, first.batch.decisionId));
        const restored = await store.reserveBatch(
          source,
          "2026-10-01",
          verdict(),
        );
        if (parserVersion === 3) {
          expect(restored).toEqual({ type: "empty" });
          expect(
            (
              await db
                .select()
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, first.batch.decisionId))
            ).at(0)?.parserVersion,
          ).toBe(3);
          expect(
            (
              await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.id, first.batch.id))
            ).at(0)?.readmissions,
          ).toBe(0);
          continue;
        }
        if (restored.type !== "reserved") {
          throw new TypeError(
            "Expected restored input to reuse its charged row",
          );
        }
        expect(restored.batch).toMatchObject({
          id: first.batch.id,
          sourceRawS3Key: originalKey,
          claimReadmission: 1,
        });
        expect(await store.pickUpBatch(restored.batch)).toBe("ready");
        await persistParsedFixture(restored.batch);
        expect(
          await store.completeBatch(restored.batch, applied(restored.batch)),
        ).toBe("applied");
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(1);
        expect(
          (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, first.batch.decisionId))
          ).at(0),
        ).toMatchObject({
          parserVersion: 2,
          sourceRawS3Key: originalKey,
          parsedSourceRawS3Key: originalKey,
        });
      }
    });

    test("reopened claims fence every stale callback and retain cumulative row quotas", async () => {
      const { source, ids, store } = await fixture();
      for (const id of ids.slice(1)) {
        await db
          .update(caseLawDecisions)
          .set({ parserVersion: 3 })
          .where(eq(caseLawDecisions.id, id));
      }
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected initial claim");
      }
      await persistParsedFixture(first.batch);
      expect(await store.completeBatch(first.batch, applied(first.batch))).toBe(
        "applied",
      );
      let activeBatch = first.batch;
      const sourceState = async () => ({
        batches: await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id)),
        audit: await db
          .select()
          .from(caseLawReplayAuditEvents)
          .where(eq(caseLawReplayAuditEvents.sourceId, source.id)),
        daily: await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        receipts: await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
        progress: await db
          .select()
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id)),
        decisions: await db
          .select()
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, source.id)),
        checkpoint: await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          ),
      });
      for (
        let epoch = 1;
        epoch <= BACKGROUND_REPLAY_LIMITS.maxRowReadmissions;
        epoch++
      ) {
        await db
          .update(caseLawDecisions)
          .set({ parserVersion: 1 })
          .where(eq(caseLawDecisions.id, first.batch.decisionId));
        const day = epoch === 1 ? "2026-10-01" : "2026-10-02";
        const reopened = await store.reserveBatch(source, day, verdict());
        if (reopened.type !== "reserved") {
          throw new TypeError("Expected bounded readmission");
        }
        expect(reopened.batch.id).toBe(first.batch.id);
        expect(reopened.batch.claimReadmission).toBe(epoch);
        const beforeStale = await sourceState();
        expect(await store.pickUpBatch(activeBatch)).toBe("waiting");
        expect(
          await store.recordFailure(activeBatch, {
            ...replayFailure("adapter-exception"),
            healthyEvidence: "none",
            durationMs: 1,
            verdict: verdict(),
          }),
        ).toBe("retryable");
        expect(
          await store.completeBatch(activeBatch, applied(activeBatch)),
        ).toBe("retryable");
        expect(await sourceState()).toEqual(beforeStale);
        activeBatch = reopened.batch;
        expect(await store.pickUpBatch(activeBatch)).toBe("ready");
        await persistParsedFixture(activeBatch);
        const afterParse = await sourceState();
        expect(
          await store.completeBatch(first.batch, applied(first.batch)),
        ).toBe("retryable");
        expect(await sourceState()).toEqual(afterParse);
        expect(
          await store.completeBatch(activeBatch, applied(activeBatch)),
        ).toBe("applied");
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(epoch === 1 ? 1 : 2);
      }
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 1 })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      expect(await store.reserveBatch(source, "2026-10-02", verdict())).toEqual(
        { type: "empty" },
      );
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, first.batch.id))
        ).at(0),
      ).toMatchObject({
        status: "retry-terminal",
        readmissions: BACKGROUND_REPLAY_LIMITS.maxRowReadmissions,
      });
      expect(await store.reserveBatch(source, "2026-10-03", verdict())).toEqual(
        { type: "empty" },
      );
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
      ).toHaveLength(2);
      await db
        .update(caseLawDecisions)
        .set({ sourceRawS3Key: "fixture/new-generation" })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      const newInput = await store.reserveBatch(
        source,
        "2026-10-03",
        verdict(),
      );
      if (newInput.type !== "reserved") {
        throw new TypeError("Expected a separately charged new input");
      }
      expect(newInput.batch.id).not.toBe(first.batch.id);
      expect(newInput.batch.claimReadmission).toBe(0);
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
      ).toHaveLength(3);
    });

    test("an exact rejected input remains terminal when its raw key returns", async () => {
      const { source, ids, store } = await fixture();
      for (const id of ids.slice(1)) {
        await db
          .update(caseLawDecisions)
          .set({ parserVersion: 3 })
          .where(eq(caseLawDecisions.id, id));
      }
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected the rejected-input reservation");
      }
      expect(
        await store.completeBatch(first.batch, {
          ...applied(first.batch),
          report: {
            ...applied(first.batch).report,
            outcome: REPLAY_ROW_OUTCOME.REJECTED,
            rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          },
        }),
      ).toBe("blocked");
      await db
        .update(caseLawDecisions)
        .set({ sourceRawS3Key: "fixture/replacement-input" })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      await db
        .update(caseLawDecisions)
        .set({ sourceRawS3Key: first.batch.sourceRawS3Key, parserVersion: 1 })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      expect(await store.reserveBatch(source, "2026-10-02", verdict())).toEqual(
        { type: "empty" },
      );
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, first.batch.id))
        ).at(0),
      ).toMatchObject({ status: "blocked", blocked: 1, readmissions: 0 });
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBlocked)
            .where(eq(caseLawReplayBlocked.decisionId, first.batch.decisionId))
        ).at(0),
      ).toMatchObject({
        sourceRawS3Key: first.batch.sourceRawS3Key,
        outcome: "rejected",
      });
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
      ).toHaveLength(1);
    });

    test("concurrent reopened reservations return one persisted claim epoch", async () => {
      const { source, ids, store } = await fixture();
      for (const id of ids.slice(1)) {
        await db
          .update(caseLawDecisions)
          .set({ parserVersion: 3 })
          .where(eq(caseLawDecisions.id, id));
      }
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected original claim");
      }
      await persistParsedFixture(first.batch);
      expect(await store.completeBatch(first.batch, applied(first.batch))).toBe(
        "applied",
      );
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 1 })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const workers = [openClient(), openClient()].map(({ db: workerDb }) =>
          createBackgroundReplayStore({
            db: workerDb,
            now: () => Date.UTC(2026, 9, 1),
          }),
        );
        const results = await Promise.all(
          workers.map(
            async (worker) =>
              await worker.reserveBatch(source, "2026-10-01", verdict()),
          ),
        );
        expect(results).toEqual([
          { ...first, batch: { ...first.batch, claimReadmission: 1 } },
          { ...first, batch: { ...first.batch, claimReadmission: 1 } },
        ]);
      });
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, first.batch.id))
        ).at(0),
      ).toMatchObject({ status: "reserved", readmissions: 1, attempts: 0 });
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
      ).toHaveLength(1);
    });

    test("persisted round-robin serves dry-run and enrolled sources fairly with bounded probes", async () => {
      const eu = await fixture();
      const cz = await fixture();
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
        .where(eq(caseLawSources.id, eu.source.id));
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.CZ_NSS })
        .where(eq(caseLawSources.id, cz.source.id));
      // Reset only the fixture-owned scheduler state for deterministic ordering.
      await db
        .delete(databaseBackfillStates)
        .where(eq(databaseBackfillStates.name, "case-law-replay:round-robin"));
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: { mode: "dry-run" },
        [ADAPTER_KEYS.CZ_NSS]: {
          mode: "enrolled",

          reviewedDryRun: "fixture",
        },
      } as const;
      const observations: BackgroundReplaySource[] = [];
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        onLag: (source) => {
          observations.push(source);
        },
      });
      const first = await store.chooseSource();
      const second = await store.chooseSource();
      const restarted = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
      });
      const third = await restarted.chooseSource();
      expect(first?.id).toBe(cz.source.id);
      expect(second?.id).toBe(eu.source.id);
      expect(third?.id).toBe(cz.source.id);
      expect(observations.map(({ rowsBehind }) => rowsBehind)).toEqual([1, 1]);
      if (!first || !second) {
        throw new TypeError("Expected both eligible sources");
      }
      sources.push(first, second);
      const held: string[] = [];
      await store.saveGateState(first, {
        ...(await store.loadGateState(first)),
        holdUntil: Date.UTC(2026, 9, 2),
      });
      const heldStore = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        onHeld: (source) => {
          held.push(source.id);
        },
      });
      expect((await heldStore.chooseSource())?.id).toBe(eu.source.id);
      expect((await heldStore.chooseSource())?.id).toBe(eu.source.id);
      expect(held).toEqual([cz.source.id]);
      const stopped = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        gate: async () => ({ kind: "unknown", signals: [] }),
      });
      expect(await stopped.chooseSource()).toBeNull();
      await db
        .update(caseLawSources)
        .set({ adapterKey: `fixture-${eu.source.id}` })
        .where(eq(caseLawSources.id, eu.source.id));
      await db
        .update(caseLawSources)
        .set({ adapterKey: `fixture-${cz.source.id}` })
        .where(eq(caseLawSources.id, cz.source.id));
    });

    test("charges reservations once, reuses pending work, and resets the daily allowance", async () => {
      const { source, store } = await fixture();
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(first.type).toBe("reserved");
      if (first.type !== "reserved") {
        return;
      }
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual(first);
      const retry = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(retry).toEqual(first);
      await persistParsedFixture(first.batch);
      expect(await store.pickUpBatch(first.batch)).toBe("ready");
      await store.completeBatch(first.batch, applied(first.batch));
      await store.completeBatch(first.batch, applied(first.batch));
      const history = await db
        .select()
        .from(caseLawReplayAuditEvents)
        .where(eq(caseLawReplayAuditEvents.sourceId, source.id));
      expect(
        history.filter(({ action }) => action === "receipt-applied"),
      ).toHaveLength(1);
      expect(
        history.find(({ action }) => action === "receipt-reserved"),
      ).toMatchObject({
        resourceId: first.batch.id,
        serviceId: "case-law-background-replay",
      });
      expect(
        history.find(({ action }) => action === "receipt-applied"),
      ).toMatchObject({
        resourceId: first.batch.id,
        details: { status: "completed", attempts: 1 },
      });
      const progress = (
        await db
          .select()
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
      ).at(0);
      expect(progress).toMatchObject({
        ticksWithoutProgress: 0,
        lastCompletedAt: new Date(Date.UTC(2026, 9, 1)),
      });
      const next = await store.reserveBatch(source, "2026-10-02", verdict());
      expect(next.type).toBe("reserved");
      if (next.type !== "reserved") {
        return;
      }
      expect(next.batch.decisionId).not.toBe(first.batch.decisionId);
      const receipts = await db
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.sourceId, source.id));
      expect(receipts).toHaveLength(2);
      expect(receipts.reduce((sum, row) => sum + row.attempted, 0)).toBe(2);
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBe(first.batch.decisionId);
    });

    test("pending recovery consumes the new day's allowance only once", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      expect(await store.pendingBatch(source, "2026-10-02")).toEqual(reserved);
      expect(await store.pendingBatch(source, "2026-10-02")).toEqual(reserved);
      const charges = await db
        .select()
        .from(caseLawReplayDailyRows)
        .where(eq(caseLawReplayDailyRows.sourceId, source.id));
      expect(
        charges.map((row) => row.budgetDay).toSorted(compareCodeUnit),
      ).toEqual(["2026-10-01", "2026-10-02"]);
      await persistParsedFixture(reserved.batch);
      await store.completeBatch(reserved.batch, applied(reserved.batch));
      expect(
        (await store.reserveBatch(source, "2026-10-02", verdict())).type,
      ).toBe("reserved");
    });

    test("an applied pipeline write survives receipt failure and recovery never applies it twice", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const adapter = {
        ...registered,
        reparseStoredRaw: (
          stored: Parameters<
            NonNullable<typeof registered.reparseStoredRaw>
          >[0],
        ) => ({
          type: "parsed" as const,
          result: plainTextIngestionResult({
            caseNumber: stored.caseNumber,
            court: stored.court,
            country: "CZE",
            language: stored.language,
            metadata: splitStoredDecisionTextMetadata(stored.metadata).metadata,
            parserVersion: 2,
            rawHash: "replay-store-new-parser",
            textFields: absentDecisionTextFields(
              TEXT_ABSENCE_REASON.NOT_PUBLISHED,
            ),
            fulltext: "Text rozhodnutí po opravě parseru.",
            documentAst: EMPTY_AST,
          }),
        }),
      };
      const fake = startFakeS3();
      const firstLease = await acquireCaseLawSourceIngestionLease({
        scopedDb,
        sourceId: source.id,
      });
      if (!firstLease) {
        fake.stop();
        throw new TypeError("Expected initial ingestion lease");
      }
      let activeStore = store;
      const options = {
        adapter,
        scopedDb,
        sourceId: source.id,
        scope: {
          type: "decision",
          decisionId: reserved.batch.decisionId,
        } as const,
        bound: { type: "at-most", limit: 1 } as const,
        pageSize: 1,
        readStoredRaw: async () =>
          new TextEncoder().encode("<html>stored decision</html>"),
      };
      try {
        const firstRunner = createBackgroundReplayRunner({
          rootDb: db,
          ingestionDb: scopedDb,
          getLease: () => firstLease,
          assertSlot: async () => {},
          log: () => {},
          adapterFor: () => adapter,
          readStoredRaw: options.readStoredRaw,
          store: {
            ...store,
            completeBatch: async (...args) =>
              await activeStore.completeBatch(...args),
          },
        });
        const first = await firstRunner.replay(reserved.batch, { apply: true });
        expect(first.haltReason).toBeNull();
        expect(first.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
        const committed = (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
        ).at(0);
        expect(committed?.parserVersion).toBe(2);
        expect(committed?.fulltext).toBe("Text rozhodnutí po opravě parseru.");
        const writes = fake.requests.filter(
          ({ method }) => method === "PUT",
        ).length;
        expect(writes).toBeGreaterThan(0);
        await withGatedTestClients(
          databaseUrl,
          async ({ openClient }) => {
            const admin = openClient().sql;
            let reachedCheckpoint = false;
            const killedStore = createBackgroundReplayStore({
              db,
              now: () => Date.UTC(2026, 9, 1),
              beforeCheckpoint: async (tx) => {
                const backend = (
                  await tx
                    .select({ pid: sql<number>`pg_backend_pid()` })
                    .from(caseLawReplayBatches)
                    .where(eq(caseLawReplayBatches.id, reserved.batch.id))
                    .limit(1)
                ).at(0);
                if (!backend) {
                  throw new TypeError("Missing applied completion PID");
                }
                reachedCheckpoint = true;
                await admin`SELECT pg_terminate_backend(${backend.pid}, 5000)`;
              },
            });
            activeStore = killedStore;
            const result = await Result.tryPromise(async () =>
              firstRunner.completeBatch(reserved.batch, {
                report: first,
                durationMs: 1,
                verdict: verdict(),
              }),
            );
            expect(reachedCheckpoint).toBe(true);
            expect(Result.isError(result)).toBe(true);
          },
          { closeMode: "force" },
        );
        await firstLease.release();
        expect(await store.pendingBatch(source, "2026-10-01")).toEqual(
          reserved,
        );
        const secondLease = await acquireCaseLawSourceIngestionLease({
          scopedDb,
          sourceId: source.id,
        });
        if (!secondLease) {
          throw new TypeError("Expected recovered ingestion lease");
        }
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const recoveredRunner = createBackgroundReplayRunner({
              rootDb: db,
              ingestionDb: scopedDb,
              getLease: () => secondLease,
              assertSlot: async () => {},
              log: () => {},
              store,
              adapterFor: () => adapter,
              readStoredRaw: options.readStoredRaw,
            });
            const recovered = await recoveredRunner.replay(reserved.batch, {
              apply: true,
            });
            expect(recovered.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
            expect(recovered.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY]).toBe(0);
            expect(
              await recoveredRunner.completeBatch(reserved.batch, {
                report: recovered,
                durationMs: 1,
                verdict: verdict(),
              }),
            ).toBe("applied");
          }
        } finally {
          await secondLease.release();
        }
        expect(
          fake.requests.filter(({ method }) => method === "PUT"),
        ).toHaveLength(writes);
        const recovered = (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
        ).at(0);
        expect(recovered?.sourceObservationOrder).toBe(
          committed?.sourceObservationOrder,
        );
        expect(recovered?.updatedAt).toEqual(committed?.updatedAt);
        expect(
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.sourceId, source.id)),
        ).toHaveLength(1);
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(1);
      } finally {
        await firstLease.release();
        fake.stop();
      }
    });

    test("lost heavy-slot sessions fence changed document writes before any effect", async () => {
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const fake = startFakeS3();
      try {
        const { source, store } = await fixture();
        const reserved = await store.reserveBatch(
          source,
          "2026-10-01",
          verdict(),
        );
        if (reserved.type !== "reserved") {
          throw new TypeError("Expected fenced replay reservation");
        }
        let fulltext = "Text rozhodnutí před opravou parseru.";
        const adapter = {
          ...registered,
          reparseStoredRaw: (
            stored: Parameters<
              NonNullable<typeof registered.reparseStoredRaw>
            >[0],
          ) => ({
            type: "parsed" as const,
            result: plainTextIngestionResult({
              caseNumber: stored.caseNumber,
              court: stored.court,
              country: "CZE",
              language: stored.language,
              metadata: splitStoredDecisionTextMetadata(stored.metadata)
                .metadata,
              parserVersion: 2,
              rawHash: "replay-slot-fence",
              textFields: absentDecisionTextFields(
                TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              ),
              fulltext,
              documentAst: EMPTY_AST,
            }),
          }),
        };
        const lease = await acquireCaseLawSourceIngestionLease({
          scopedDb,
          sourceId: source.id,
        });
        if (!lease) {
          throw new TypeError("Expected fenced replay source lease");
        }
        const raw = new TextEncoder().encode("<html>stored decision</html>");
        try {
          const seeded = createBackgroundReplayRunner({
            rootDb: db,
            ingestionDb: scopedDb,
            getLease: () => lease,
            assertSlot: async () => {},
            store,
            log: () => {},
            adapterFor: () => adapter,
            readStoredRaw: async () => raw,
          });
          expect(
            (await seeded.replay(reserved.batch, { apply: true })).outcomes
              .applied,
          ).toBe(1);
          const fixedPoint = await replayCaseLawSource({
            adapter,
            scopedDb,
            sourceId: source.id,
            scope: {
              type: "decision",
              decisionId: reserved.batch.decisionId,
            },
            bound: { type: "at-most", limit: 1 },
            pageSize: 1,
            sourceLease: null,
            readStoredRaw: async () => raw,
          });
          if (fixedPoint.type !== "ran") {
            throw new TypeError("Expected seeded replay fixed point");
          }
          expect(fixedPoint.report.outcomes.unchanged).toBe(1);
          await db
            .update(caseLawDecisions)
            .set({ parserVersion: 1 })
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
          fulltext = "Text rozhodnutí po opravě parseru.";
          const before = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
          ).at(0);
          if (before === undefined) {
            throw new TypeError("Expected seeded decision before fencing");
          }
          const writesBefore = fake.requests.filter(
            ({ method }) => method === "PUT",
          ).length;
          await withGatedTestClients(
            databaseUrl,
            async ({ openClient }) => {
              const first = await openClient().sql.reserve();
              const rival = await openClient().sql.reserve();
              const admin = openClient().sql;
              const makeSlot = (session: typeof first) =>
                createHeavyWorkSlot({
                  kind: "backfill_batch",
                  session: {
                    query: async (statement, parameters) =>
                      await session.unsafe<{ acquired: boolean }[]>(statement, [
                        ...parameters,
                      ]),
                  },
                });
              const firstSlot = makeSlot(first);
              const rivalSlot = makeSlot(rival);
              const expectAcquisition = async (
                slot: typeof firstSlot,
                expected: boolean,
              ) => {
                const acquired = await slot.tryAcquire();
                if (acquired.isErr()) {
                  throw acquired.error;
                }
                expect(acquired.value).toBe(expected);
              };
              const pid = (
                await first.unsafe<{ pid: number }[]>(
                  "SELECT pg_backend_pid() AS pid",
                )
              ).at(0)?.pid;
              if (pid === undefined) {
                throw new TypeError("Missing heavy-slot backend identity");
              }
              let reads = 0;
              let fenceChecks = 0;
              const cleanupState = { killed: false };
              try {
                await expectAcquisition(firstSlot, true);
                await expectAcquisition(rivalSlot, false);
                const runner = createBackgroundReplayRunner({
                  rootDb: db,
                  ingestionDb: scopedDb,
                  getLease: () => lease,
                  store,
                  log: () => {},
                  adapterFor: () => adapter,
                  readStoredRaw: async () => {
                    reads += 1;
                    if (reads === 2) {
                      const terminated = await admin<
                        { terminated: boolean }[]
                      >`SELECT pg_terminate_backend(${pid}, 5000) AS terminated`;
                      expect(terminated.at(0)?.terminated).toBe(true);
                      cleanupState.killed = true;
                      await expectAcquisition(rivalSlot, true);
                    }
                    return raw;
                  },
                  assertSlot: async () => {
                    fenceChecks += 1;
                    const current = (
                      await first.unsafe<{ pid: number }[]>(
                        "SELECT pg_backend_pid() AS pid",
                      )
                    ).at(0)?.pid;
                    if (current !== pid) {
                      throw new TypeError("Heavy-work session was replaced");
                    }
                  },
                });
                const replayed = await runner.replay(reserved.batch, {
                  apply: true,
                });
                expect(reads).toBe(2);
                expect(cleanupState.killed).toBe(true);
                expect(fenceChecks).toBeGreaterThan(0);
                expect(replayed.outcomes.applied).toBe(0);
                expect(replayed.haltReason).not.toBeNull();
                expect(
                  await db
                    .select()
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, reserved.batch.decisionId)),
                ).toEqual([before]);
                expect(
                  fake.requests.filter(({ method }) => method === "PUT"),
                ).toHaveLength(writesBefore);
                expect(await store.pendingBatch(source, "2026-10-01")).toEqual(
                  reserved,
                );
                const checkpoint = (
                  await db
                    .select()
                    .from(databaseBackfillStates)
                    .where(
                      eq(
                        databaseBackfillStates.name,
                        `case-law-replay:${source.id}:2`,
                      ),
                    )
                ).at(0);
                expect(checkpoint?.cursor).toBeNull();
              } finally {
                await rivalSlot.close();
                if (!cleanupState.killed) {
                  await firstSlot.close();
                }
                await first.release();
                await rival.release();
              }
            },
            { closeMode: "force" },
          );
        } finally {
          await lease.release();
        }
      } finally {
        fake.stop();
      }
    });

    test("runner apply mode never writes any classified rejection", async () => {
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const fake = startFakeS3();
      try {
        for (const rejection of Object.values(STORED_RAW_REPARSE_REJECTION)) {
          const { source, store } = await fixture();
          const reserved = await store.reserveBatch(
            source,
            "2026-10-01",
            verdict(),
          );
          expect(reserved.type).toBe("reserved");
          if (reserved.type !== "reserved") {
            throw new TypeError("Expected rejected-row reservation");
          }
          const before = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
          ).at(0);
          const lease = await acquireCaseLawSourceIngestionLease({
            scopedDb,
            sourceId: source.id,
          });
          if (!lease) {
            throw new TypeError("Expected rejected-row completion lease");
          }
          let slotChecks = 0;
          try {
            const runner = createBackgroundReplayRunner({
              rootDb: db,
              ingestionDb: scopedDb,
              getLease: () => lease,
              assertSlot: async () => {
                slotChecks += 1;
              },
              store,
              log: () => {},
              readStoredRaw: async () =>
                new TextEncoder().encode("rejected fixture"),
              adapterFor: () => ({
                ...registered,
                reparseStoredRaw: () => ({
                  type: "rejected",
                  rejection,
                  detail: "synthetic rejected payload",
                }),
              }),
            });
            const report = await runner.replay(reserved.batch, { apply: true });
            expect(report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(1);
            expect(report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
            expect(slotChecks).toBe(0);
            await runner.completeBatch(reserved.batch, {
              report,
              durationMs: 1,
              verdict: verdict(),
            });
            expect(slotChecks).toBe(1);
            const after = (
              await db
                .select()
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
            ).at(0);
            expect(after).toEqual(before);
            expect(fake.requests).toHaveLength(0);
          } finally {
            await lease.release();
          }
        }
      } finally {
        fake.stop();
      }
    });

    test("a pending older generation is superseded before reserving the newer parser", async () => {
      const { source, store } = await fixture();
      const old = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(old.type).toBe("reserved");
      if (old.type !== "reserved") {
        return;
      }
      const nextSource = { ...source, currentParserVersion: 3 };
      expect(await store.pendingBatch(nextSource, "2026-10-02")).toEqual({
        type: "empty",
      });
      const superseded = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, old.batch.id))
      ).at(0);
      expect(superseded?.status).toBe("superseded");
      const next = await store.reserveBatch(
        nextSource,
        "2026-10-02",
        verdict(),
      );
      expect(next.type).toBe("reserved");
      if (next.type !== "reserved") {
        return;
      }
      expect(next.batch.targetParserVersion).toBe(3);
      expect(next.batch.decisionId).toBe(old.batch.decisionId);
      expect(next.batch.id).not.toBe(old.batch.id);
      sources.push(nextSource);
    });

    test("backend death rolls receipt and blocked outcome back together, then resumes twice", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const replayedRawKey =
        (
          await db
            .select({ rawKey: caseLawDecisions.sourceRawS3Key })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
        ).at(0)?.rawKey ?? panic("Expected replayed raw generation");
      const completion = {
        report: {
          id: reserved.batch.decisionId,
          ...replayedKeyOf(reserved.batch.sourceRawS3Key),
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
        },
        durationMs: 1,
        verdict: verdict(),
      };
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const admin = openClient().sql;
          let reachedCheckpoint = false;
          const killedStore = createBackgroundReplayStore({
            db,
            now: () => Date.UTC(2026, 9, 1),
            beforeCheckpoint: async (tx) => {
              const backend = (
                await tx
                  .select({ pid: sql<number>`pg_backend_pid()` })
                  .from(caseLawReplayBatches)
                  .where(eq(caseLawReplayBatches.id, reserved.batch.id))
                  .limit(1)
              ).at(0);
              if (backend === undefined) {
                throw new TypeError("Missing completion backend PID");
              }
              reachedCheckpoint = true;
              await admin`SELECT pg_terminate_backend(${backend.pid}, 5000)`;
            },
          });
          const result = await Result.tryPromise(async () =>
            killedStore.completeBatch(reserved.batch, completion),
          );
          expect(reachedCheckpoint).toBe(true);
          expect(Result.isError(result)).toBe(true);
        },
        { closeMode: "force" },
      );
      const receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, reserved.batch.id))
      ).at(0);
      expect(receipt?.status).toBe("reserved");
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(0);
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBeNull();
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual(reserved);
      await store.completeBatch(reserved.batch, completion);
      await store.completeBatch(reserved.batch, completion);
      const terminalReceipts = await db
        .select()
        .from(caseLawReplayBlocked)
        .where(eq(caseLawReplayBlocked.sourceId, source.id));
      expect(terminalReceipts).toHaveLength(1);
      expect(terminalReceipts.at(0)?.sourceRawS3Key).toBe(replayedRawKey);
      expect(
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id)),
      ).toHaveLength(1);
      const settled = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(settled?.cursor).toBe(reserved.batch.decisionId);
    });

    test("independent workers share one daily accounting charge per reservation", async () => {
      const { source, store } = await fixture();
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const firstStore = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.UTC(2026, 9, 1),
        });
        const secondStore = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.UTC(2026, 9, 1),
        });
        const results = await Promise.all([
          firstStore.reserveBatch(source, "2026-10-01", verdict()),
          secondStore.reserveBatch(source, "2026-10-01", verdict()),
        ]);
        const first = results.at(0);
        expect(first?.type).toBe("reserved");
        expect(results.at(1)).toEqual(first);
        if (first?.type !== "reserved") {
          throw new TypeError("Expected shared receipt");
        }
        expect(
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.sourceId, source.id)),
        ).toHaveLength(1);
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(1);
        await persistParsedFixture(first.batch);
        await store.completeBatch(first.batch, applied(first.batch));
        const next = await Promise.all([
          firstStore.reserveBatch(source, "2026-10-01", verdict()),
          secondStore.reserveBatch(source, "2026-10-01", verdict()),
        ]);
        expect(next.at(0)?.type).toBe("reserved");
        expect(next.at(1)).toEqual(next.at(0));
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(2);
      });
    });

    test("unchanged receipts require complete proof for the exact current input", async () => {
      for (const invalidation of [
        "missing-proof",
        "raw-input",
        "parser-version",
      ] as const) {
        const { source, store } = await fixture();
        const reserved = await store.reserveBatch(
          source,
          "2026-10-01",
          verdict(),
        );
        if (reserved.type !== "reserved") {
          throw new TypeError("Expected concurrent unchanged reservation");
        }
        if (invalidation !== "missing-proof") {
          await persistParsedFixture(reserved.batch);
        }
        if (invalidation === "raw-input") {
          await db
            .update(caseLawDecisions)
            .set({
              sourceRawS3Key: "fixture/replaced-input",
            })
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
        }
        if (invalidation === "parser-version") {
          await db
            .update(caseLawDecisions)
            .set({ parserVersion: 0 })
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
        }
        expect(
          await store.completeBatch(reserved.batch, {
            report: {
              id: reserved.batch.decisionId,
              ...replayedKeyOf(reserved.batch.sourceRawS3Key),
              caseNumber: "fixture",
              language: "cs",
              outcome: REPLAY_ROW_OUTCOME.UNCHANGED,
            },
            durationMs: 1,
            verdict: verdict(),
          }),
        ).toBe("retryable");
        expect(
          await db
            .select()
            .from(caseLawReplayBlocked)
            .where(
              eq(caseLawReplayBlocked.decisionId, reserved.batch.decisionId),
            ),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.id, reserved.batch.id))
          ).at(0)?.status,
        ).toBe("reserved");
      }
    });

    test("every registered jurisdiction receipts all terminal outcomes and only reselects after a parser bump", async () => {
      const outcomes = ["changed", "unchanged", "rejected"] as const;
      for (const registered of listAdapters()) {
        const { source: baseSource, ids, store } = await fixture();
        const source = { ...baseSource, adapterKey: registered.key };
        for (const outcome of outcomes) {
          const reserved = await store.reserveBatch(
            source,
            "2026-10-01",
            verdict(),
          );
          if (reserved.type !== "reserved") {
            throw new TypeError("Expected terminal outcome reservation");
          }
          const before = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
          ).at(0);
          if (before === undefined) {
            throw new TypeError("Expected receipt fixture decision");
          }
          // Both successful parse outcomes use the canonical writer's complete proof.
          if (outcome !== "rejected") {
            await persistParsedFixture(reserved.batch);
          }
          const beforeReceipt = await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
          const identity = {
            ...replayedKeyOf(reserved.batch.sourceRawS3Key),
            id: reserved.batch.decisionId,
            caseNumber: before.caseNumber,
            language: before.language,
          };
          const report =
            outcome === "rejected"
              ? {
                  ...identity,
                  outcome: REPLAY_ROW_OUTCOME.REJECTED,
                  rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
                }
              : {
                  ...identity,
                  outcome:
                    outcome === "changed"
                      ? REPLAY_ROW_OUTCOME.APPLIED
                      : REPLAY_ROW_OUTCOME.UNCHANGED,
                };
          const completion = {
            report: report satisfies ReplayRowReport,
            durationMs: 1,
            verdict: verdict(),
          };
          await store.completeBatch(reserved.batch, completion);
          await store.completeBatch(reserved.batch, completion);
          expect(
            await db
              .select()
              .from(caseLawReplayBlocked)
              .where(
                eq(caseLawReplayBlocked.decisionId, reserved.batch.decisionId),
              ),
          ).toMatchObject([
            {
              decisionId: reserved.batch.decisionId,
              parserVersionTo: 2,
              outcome,
              reason:
                outcome === "rejected"
                  ? STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH
                  : null,
            },
          ]);
          expect(
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId)),
          ).toEqual(beforeReceipt);
          const scope = {
            type: "decision",
            decisionId: reserved.batch.decisionId,
          } as const;
          expect(
            await selectScopeEnd({
              scopedDb,
              sourceId: source.id,
              scope,
              selection: {
                type: "background",
                currentParserVersion: 2,
                mode: "enrolled",
              },
            }),
          ).toBeNull();
          expect(
            await selectScopeEnd({
              scopedDb,
              sourceId: source.id,
              scope,
              selection: {
                type: "background",
                currentParserVersion: 3,
                mode: "enrolled",
              },
            }),
          ).toBe(reserved.batch.decisionId);
        }
        const receipts = await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id));
        expect(
          receipts
            .map(({ decisionId }) => decisionId)
            .toSorted(compareCodeUnit),
        ).toEqual([...ids]);
        const daily = await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id));
        expect(daily).toHaveLength(outcomes.length);
        expect(
          (await store.reserveBatch(source, "2026-10-01", verdict())).type,
        ).toBe("empty");
      }
    });

    test("rejected completion is idempotent and removes only the current blocked generation from selection", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const completion = {
        report: {
          id: reserved.batch.decisionId,
          ...replayedKeyOf(reserved.batch.sourceRawS3Key),
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          detail: "fixture identity changed",
        },
        durationMs: 1,
        verdict: verdict(),
      };
      await store.completeBatch(reserved.batch, completion);
      await store.completeBatch(reserved.batch, completion);
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(1);
      const row = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, reserved.batch.id))
      ).at(0);
      expect(row?.status).toBe("blocked");
      expect(row?.blocked).toBe(1);
      expect(row?.applied).toBe(0);
      const scope = {
        type: "decision",
        decisionId: reserved.batch.decisionId,
      } as const;
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: {
            type: "background",
            currentParserVersion: 2,
            mode: "enrolled",
          },
        }),
      ).toBeNull();
      await db
        .update(caseLawDecisions)
        .set({
          sourceHash: "f".repeat(64),
          sourceRawS3Key: "fixture/new-input",
        })
        .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: {
            type: "background",
            currentParserVersion: 2,
            mode: "enrolled",
          },
        }),
      ).toBe(reserved.batch.decisionId);
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: {
            type: "background",
            currentParserVersion: 3,
            mode: "enrolled",
          },
        }),
      ).toBe(reserved.batch.decisionId);
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBe(reserved.batch.decisionId);
    });

    test("a known raw key remains an exact terminal identity without a source hash", async () => {
      const { source, store } = await fixture();
      const decision = (
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, source.id))
          .limit(1)
      ).at(0);
      if (!decision) {
        throw new TypeError("Expected raw-less replay fixture");
      }
      await db
        .update(caseLawDecisions)
        .set({ sourceHash: null })
        .where(eq(caseLawDecisions.id, decision.id));
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      if (reserved.type !== "reserved") {
        throw new TypeError("Expected raw-less replay reservation");
      }
      await store.completeBatch(reserved.batch, {
        report: {
          id: reserved.batch.decisionId,
          ...replayedKeyOf(reserved.batch.sourceRawS3Key),
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          detail: "fixture identity changed",
        },
        durationMs: 1,
        verdict: verdict(),
      });
      expect(
        (
          await db
            .select({ rawKey: caseLawReplayBlocked.sourceRawS3Key })
            .from(caseLawReplayBlocked)
            .where(eq(caseLawReplayBlocked.decisionId, decision.id))
        ).at(0)?.rawKey,
      ).toBe(reserved.batch.sourceRawS3Key);
    });
    test("an incomplete reported write stays reserved until the persisted stamp proves recovery", async () => {
      const { source } = await fixture();
      let time = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => time });
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      if (reserved.type !== "reserved") {
        throw new TypeError("Expected incomplete write fixture");
      }
      expect(await store.pickUpBatch(reserved.batch)).toBe("ready");
      expect(
        await store.completeBatch(reserved.batch, applied(reserved.batch)),
      ).toBe("retryable");
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(0);
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, reserved.batch.id))
        ).at(0),
      ).toMatchObject({
        status: "reserved",
        applied: 0,
        blocked: 0,
        failureCode: "writer-retryable",
      });
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
      // Past its delay the row still yields to fresh rows: a systemic retry
      // never blocks the sweep, and it stays reserved for the stamp check.
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      await persistParsedFixture(reserved.batch);
      expect(
        await store.completeBatch(reserved.batch, applied(reserved.batch)),
      ).toBe("applied");
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toMatchObject([
        {
          decisionId: reserved.batch.decisionId,
          outcome: "changed",
          reason: null,
        },
      ]);
    });

    test("backoff skips poison rows, persists classified reasons and bounds attempts", async () => {
      const { source, ids } = await fixture();
      let currentTime = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => currentTime });
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected poison fixture");
      }
      const failure = {
        ...replayFailure("adapter-exception"),
        healthyEvidence: "none",
        durationMs: 1,
        verdict: verdict(),
      } as const;
      expect(await store.pickUpBatch(first.batch)).toBe("ready");
      expect(await store.recordFailure(first.batch, failure)).toBe("retryable");
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      const second = await store.reserveBatch(source, "2026-10-01", verdict());
      if (second.type !== "reserved") {
        throw new TypeError("Expected later fixture while first backs off");
      }
      expect(second.batch.decisionId).toBe(ids[1]);
      await persistParsedFixture(second.batch);
      await store.completeBatch(second.batch, applied(second.batch));
      for (
        let attempt = 2;
        attempt <= BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
        attempt++
      ) {
        currentTime += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        const recovered = await store.pendingBatch(source, "2026-10-01");
        if (recovered.type !== "reserved") {
          throw new TypeError("Expected due poison fixture");
        }
        expect(recovered.batch.id).toBe(first.batch.id);
        expect(await store.pickUpBatch(recovered.batch)).toBe("ready");
        expect(await store.recordFailure(recovered.batch, failure)).toBe(
          attempt === BACKGROUND_REPLAY_LIMITS.maxRowAttempts
            ? "retry-exhausted"
            : "retryable",
        );
      }
      const failed = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, first.batch.id))
      ).at(0);
      expect(failed).toMatchObject({
        status: "retry-exhausted",
        attempts: BACKGROUND_REPLAY_LIMITS.maxRowAttempts,
        readmissions: 0,
        failed: 1,
        failureCode: "adapter-exception",
        failureMessageClass: "adapter",
        retryAt: new Date(
          currentTime + BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs,
        ),
      });
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      currentTime += BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs - 1;
      expect(await store.pendingBatch(source, "2026-10-08")).toEqual({
        type: "empty",
      });
      currentTime++;
      const readmitted = await store.pendingBatch(source, "2026-10-08");
      expect(readmitted).toEqual({
        ...first,
        batch: { ...first.batch, claimReadmission: 1 },
      });
      if (readmitted.type !== "reserved") {
        throw new TypeError("Expected readmitted poison row");
      }
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, first.batch.id))
        ).at(0),
      ).toMatchObject({
        status: "reserved",
        attempts: 0,
        readmissions: 1,
        failed: 0,
        systemicFailures: 0,
        systemicProgress: 0,
        attemptState: "idle",
        retryAt: null,
      });
      expect(await store.pickUpBatch(first.batch)).toBe("waiting");
      expect(await store.pickUpBatch(readmitted.batch)).toBe("ready");
      expect(await store.recordFailure(readmitted.batch, failure)).toBe(
        "retryable",
      );
      const next = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(next.type).toBe("reserved");
      if (next.type !== "reserved") {
        throw new TypeError("Expected remaining row");
      }
      expect(next.batch.decisionId).toBe(ids[2]);
    });

    test("crashed pickups wait seven days between bounded readmissions and remain visible when terminal", async () => {
      const { source } = await fixture();
      let time = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => time });
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected crash fixture");
      }
      let activeBatch = first.batch;
      for (
        let readmissions = 0;
        readmissions <= BACKGROUND_REPLAY_LIMITS.maxRowReadmissions;
        readmissions++
      ) {
        for (
          let attempt = 0;
          attempt < BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
          attempt++
        ) {
          expect(await store.pickUpBatch(activeBatch)).toBe("ready");
          time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        }
        const terminal =
          readmissions === BACKGROUND_REPLAY_LIMITS.maxRowReadmissions;
        expect(await store.pickUpBatch(activeBatch)).toBe(
          terminal ? "retry-terminal" : "retry-exhausted",
        );
        const exhausted = (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, first.batch.id))
        ).at(0);
        expect(exhausted).toMatchObject({
          status: terminal ? "retry-terminal" : "retry-exhausted",
          attempts: BACKGROUND_REPLAY_LIMITS.maxRowAttempts,
          readmissions,
          failed: 1,
          failureCode: "unexpected",
          retryAt: terminal
            ? null
            : new Date(time + BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs),
        });
        expect(await store.pickUpBatch(activeBatch)).toBe("waiting");
        expect(
          await db
            .select()
            .from(caseLawReplayBlocked)
            .where(eq(caseLawReplayBlocked.decisionId, first.batch.decisionId)),
        ).toHaveLength(0);
        expect(
          await selectScopeEnd({
            scopedDb,
            sourceId: source.id,
            scope: { type: "decision", decisionId: first.batch.decisionId },
            selection: {
              type: "background",
              currentParserVersion: 2,
              mode: "enrolled",
            },
          }),
        ).toBeNull();
        time += BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs - 1;
        expect(await store.pendingBatch(source, "2026-10-08")).toEqual({
          type: "empty",
        });
        time++;
        const recovered = await store.pendingBatch(source, "2026-10-08");
        if (terminal) {
          expect(recovered).toEqual({ type: "empty" });
          time += BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs;
          expect(await store.pendingBatch(source, "2026-10-08")).toEqual({
            type: "empty",
          });
          continue;
        }
        expect(recovered).toEqual({
          ...first,
          batch: { ...first.batch, claimReadmission: readmissions + 1 },
        });
        if (recovered.type !== "reserved") {
          throw new TypeError("Expected next crash claim epoch");
        }
        expect(await store.pickUpBatch(activeBatch)).toBe("waiting");
        activeBatch = recovered.batch;
        expect(
          (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.id, first.batch.id))
          ).at(0),
        ).toMatchObject({
          status: "reserved",
          attempts: 0,
          attemptState: "idle",
          failed: 0,
          systemicFailures: 0,
          systemicProgress: 0,
          readmissions: readmissions + 1,
          retryAt: null,
        });
      }
      const scope = {
        type: "decision",
        decisionId: first.batch.decisionId,
      } as const;
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: {
            type: "background",
            currentParserVersion: 2,
            mode: "enrolled",
          },
        }),
      ).toBeNull();
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: {
            type: "background",
            currentParserVersion: 3,
            mode: "enrolled",
          },
        }),
      ).toBe(first.batch.decisionId);
    });

    test("systemic failure refunds only its pickup and persists a source hold without settling a pending mirror", async () => {
      const { source } = await fixture();
      const time = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => time });
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      if (first.type !== "reserved") {
        throw new TypeError("Expected systemic fixture");
      }
      expect(await store.pickUpBatch(first.batch)).toBe("ready");
      await db
        .update(caseLawDecisions)
        .set({
          parserVersion: 2,
          corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      const failure = {
        ...replayFailure("tick-deadline"),
        healthyEvidence: "none" as const,
        durationMs: 1,
        verdict: verdict(),
      };
      expect(await store.recordFailure(first.batch, failure)).toBe("retryable");
      expect(await store.recordFailure(first.batch, failure)).toBe("retryable");
      const receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, first.batch.id))
      ).at(0);
      expect(receipt).toMatchObject({
        status: "reserved",
        attempts: 0,
        attemptState: "idle",
        applied: 0,
      });
      expect((await store.loadGateState(source)).holdUntil).toBeGreaterThan(
        time,
      );
      await db
        .update(caseLawDecisions)
        .set({ corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      await persistParsedFixture(first.batch);
      expect(await store.completeBatch(first.batch, applied(first.batch))).toBe(
        "applied",
      );
    });

    test("systemic queue samples healthy rows and isolates poison only with fresh verified progress", async () => {
      const { source } = await fixture();
      let time = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => time });
      const poison = await store.reserveBatch(source, "2026-10-01", verdict());
      if (poison.type !== "reserved") {
        throw new TypeError("Expected poison row");
      }
      const failure = {
        ...replayFailure("stored-raw-timeout"),
        healthyEvidence: "none" as const,
        durationMs: 1,
        verdict: verdict(),
      };
      expect(await store.pickUpBatch(poison.batch)).toBe("ready");
      expect(await store.recordFailure(poison.batch, failure)).toBe(
        "retryable",
      );
      time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      const healthy = await store.reserveBatch(source, "2026-10-01", verdict());
      if (healthy.type !== "reserved") {
        throw new TypeError("Expected healthy sample");
      }
      expect(healthy.batch.decisionId).not.toBe(poison.batch.decisionId);
      await persistParsedFixture(healthy.batch);
      expect(
        await store.completeBatch(healthy.batch, applied(healthy.batch)),
      ).toBe("applied");
      for (let attempt = 2; attempt <= 3; attempt++) {
        time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        expect(await store.pickUpBatch(poison.batch)).toBe("ready");
        expect(await store.recordFailure(poison.batch, failure)).toBe(
          attempt === 3 ? "isolated" : "retryable",
        );
      }
      let receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, poison.batch.id))
      ).at(0);
      expect(receipt).toMatchObject({
        attempts: 1,
        systemicFailures: 0,
        systemicProgress: 1,
      });
      // A later whole-system outage gets a fresh progress baseline; the old
      // successful neighbour cannot keep charging the suspect row.
      for (let attempt = 0; attempt < 6; attempt++) {
        time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        expect(await store.pickUpBatch(poison.batch)).toBe("ready");
        expect(await store.recordFailure(poison.batch, failure)).toBe(
          "retryable",
        );
      }
      receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, poison.batch.id))
      ).at(0);
      expect(receipt).toMatchObject({
        status: "reserved",
        attempts: 1,
        systemicFailures: 3,
        systemicProgress: 1,
      });
      const progress = (
        await db
          .select()
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
      ).at(0);
      expect(progress?.completedRows).toBe(1);
    });

    test("a real systemic outage rotates the pending queue without exhausting any row", async () => {
      const { source } = await fixture();
      let time = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => time });
      const failure = {
        ...replayFailure("stored-raw-read"),
        healthyEvidence: "none" as const,
        durationMs: 1,
        verdict: verdict(),
      };
      const picked: string[] = [];
      for (let tick = 0; tick < 9; tick++) {
        const pending = await store.pendingBatch(source, "2026-10-01");
        const admission =
          pending.type === "empty"
            ? await store.reserveBatch(source, "2026-10-01", verdict())
            : pending;
        if (admission.type !== "reserved") {
          throw new TypeError("Expected outage sample");
        }
        picked.push(admission.batch.id);
        expect(await store.pickUpBatch(admission.batch)).toBe("ready");
        expect(await store.recordFailure(admission.batch, failure)).toBe(
          "retryable",
        );
        time += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
      }
      expect(new Set(picked.slice(0, 3)).size).toBe(3);
      expect(picked.slice(3, 6)).toEqual(picked.slice(0, 3));
      const receipts = await db
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.sourceId, source.id));
      expect(
        receipts.every(
          ({ status, attempts }) => status === "reserved" && attempts === 0,
        ),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(0);
    });

    test("a moved stamp settles applied after a receipt failure on the final allowed attempt", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      if (reserved.type !== "reserved") {
        throw new TypeError("Expected final-attempt receipt");
      }
      await db
        .update(caseLawReplayBatches)
        .set({
          attempts: BACKGROUND_REPLAY_LIMITS.maxRowAttempts - 1,
          failed: 1,
        })
        .where(eq(caseLawReplayBatches.id, reserved.batch.id));
      expect(await store.pickUpBatch(reserved.batch)).toBe("ready");
      await persistParsedFixture(reserved.batch);
      expect(
        await store.recordFailure(reserved.batch, {
          ...replayFailure("receipt-write"),
          healthyEvidence: "none",
          durationMs: 1,
          verdict: verdict(),
        }),
      ).toBe("applied");
      const receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, reserved.batch.id))
      ).at(0);
      expect(receipt).toMatchObject({
        status: "completed",
        outcome: REPLAY_ROW_OUTCOME.APPLIED,
        attempts: BACKGROUND_REPLAY_LIMITS.maxRowAttempts - 1,
        applied: 1,
        failed: 0,
        blocked: 0,
        retryAt: null,
      });
      // The moved stamp is the terminal receipt: one changed row, no reason.
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(
            eq(caseLawReplayBlocked.decisionId, reserved.batch.decisionId),
          ),
      ).toMatchObject([
        {
          decisionId: reserved.batch.decisionId,
          outcome: "changed",
          reason: null,
        },
      ]);
      const cursor = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(
              databaseBackfillStates.name,
              `case-law-replay:${source.id}:${source.currentParserVersion}`,
            ),
          )
      ).at(0)?.cursor;
      expect(cursor).toBe(reserved.batch.decisionId);
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      // No recordTick call occurs: the verified receipt transaction owns progress.
      const progress = (
        await db
          .select()
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
      ).at(0);
      expect(progress).toMatchObject({
        ticksWithoutProgress: 0,
        lastCompletedAt: new Date(Date.UTC(2026, 9, 1)),
      });
    });

    test("dry-run cursor resumes across fresh stores while receipts never enter apply recovery", async () => {
      const { source: enrolled, ids } = await fixture();
      const source = { ...enrolled, mode: "dry-run" } as const;
      let clock = Date.UTC(2026, 9, 1);
      const store = createBackgroundReplayStore({ db, now: () => clock });
      const before = await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, source.id));
      const first = await store.previewBatch(source, null);
      if (first.type !== "reserved") {
        throw new TypeError("Expected first preview");
      }
      await store.advancePreview(first.batch);
      const restarted = createBackgroundReplayStore({ db, now: () => clock });
      const second = await restarted.previewBatch(source, null);
      if (second.type !== "reserved") {
        throw new TypeError("Expected second preview after restart");
      }
      expect(second.batch.decisionId).toBe(ids[1]);
      await restarted.advancePreview(second.batch);
      await restarted.resetDryRunCursor(source);
      expect(await restarted.previewBatch(source, null)).toEqual({
        type: "empty",
      });
      clock += DAY_IN_MS;
      const reset = await restarted.previewBatch(source, null);
      if (reset.type !== "reserved") {
        throw new TypeError("Expected preview after reset and UTC rollover");
      }
      expect(reset.batch.decisionId).toBe(first.batch.decisionId);
      expect(await restarted.pendingBatch(enrolled, "2026-10-02")).toEqual({
        type: "empty",
      });
      expect(
        await db
          .select()
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, source.id)),
      ).toEqual(before);
      const receipts = await db
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.sourceId, source.id));
      expect(receipts).toHaveLength(2);
      expect(
        receipts.every(
          (row) =>
            row.id.endsWith(":dry-run") &&
            row.status === "completed" &&
            row.applied === 0,
        ),
      ).toBe(true);
      await restarted.advancePreview(reset.batch);
      const apply = await restarted.reserveBatch(
        enrolled,
        "2026-10-02",
        verdict(),
      );
      if (apply.type !== "reserved") {
        throw new TypeError(
          "Expected apply admission after successful preview",
        );
      }
      expect(apply.batch.decisionId).toBe(first.batch.decisionId);
      expect(apply.batch.id).not.toBe(first.batch.id);
      expect(apply.batch.id.endsWith(":dry-run")).toBe(false);
    });

    test("dry-run previews continue after restart without a daily operating cap", async () => {
      const { source: enrolled, ids } = await fixture();
      const source = { ...enrolled, mode: "dry-run" } as const;
      let clock = Date.UTC(2026, 9, 1, 23, 59, 59);
      const store = createBackgroundReplayStore({ db, now: () => clock });
      const first = await store.previewBatch(source, null);
      if (first.type !== "reserved") {
        throw new TypeError("Expected preview");
      }
      await store.advancePreview(first.batch);
      const restarted = createBackgroundReplayStore({ db, now: () => clock });
      const second = await restarted.previewBatch(source, null);
      if (second.type !== "reserved") {
        throw new TypeError("Expected same-day preview after restart");
      }
      expect(second.batch.decisionId).toBe(ids[1]);
      await restarted.advancePreview(second.batch);
      clock += 1000;
      const third = await restarted.previewBatch(source, null);
      if (third.type !== "reserved") {
        throw new TypeError("Expected preview after midnight");
      }
      expect(third.batch.decisionId).toBe(ids[2]);
      const charges = await db
        .select()
        .from(caseLawReplayDailyRows)
        .where(eq(caseLawReplayDailyRows.sourceId, source.id));
      expect(
        charges.map((row) => row.budgetDay).toSorted(compareCodeUnit),
      ).toEqual(["2026-10-01", "2026-10-01", "2026-10-02"]);
    });

    test("concurrent preview and apply retain independent accounting identities", async () => {
      const { source } = await fixture();
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const preview = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.UTC(2026, 9, 1),
        });
        const apply = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.UTC(2026, 9, 1),
        });
        const results = await Promise.all([
          preview.previewBatch({ ...source, mode: "dry-run" }, null),
          apply.reserveBatch(source, "2026-10-01", verdict()),
        ]);
        expect(results.filter((row) => row.type === "reserved")).toHaveLength(
          2,
        );
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(2);
      });
    });

    test("exhausted previews advance durably until an explicit reset re-admits them without excluding apply", async () => {
      const { source: enrolled, ids } = await fixture();
      const source = { ...enrolled, mode: "dry-run" } as const;
      let clock = Date.UTC(2026, 9, 1);
      const restart = () =>
        createBackgroundReplayStore({ db, now: () => clock });
      const failure = {
        ...replayFailure("adapter-exception"),
        healthyEvidence: "none",
        durationMs: 1,
        verdict: verdict(),
      } as const;
      let receiptId = "";
      for (
        let attempt = 1;
        attempt <= BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
        attempt++
      ) {
        const store = restart();
        const preview = await store.previewBatch(source, null);
        if (preview.type !== "reserved") {
          throw new TypeError("Expected due failed preview");
        }
        receiptId = preview.batch.id;
        expect(preview.batch.decisionId).toBe(ids[0]);
        const exhausted = attempt === BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
        expect(await store.recordFailure(preview.batch, failure)).toBe(
          exhausted ? "failed" : "retryable",
        );
        const checkpoint = (
          await db
            .select()
            .from(databaseBackfillStates)
            .where(
              eq(
                databaseBackfillStates.name,
                `case-law-replay:${source.id}:2:dry-run`,
              ),
            )
        ).at(0);
        expect(checkpoint?.cursor ?? null).toBe(exhausted ? ids[0] : null);
        if (!exhausted) {
          expect(await restart().previewBatch(source, null)).toEqual({
            type: "waiting",
          });
          clock += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        }
      }
      const terminal = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, receiptId))
      ).at(0);
      expect(terminal).toMatchObject({
        failed: 1,
        attempts: BACKGROUND_REPLAY_LIMITS.maxRowAttempts,
        failureCode: "adapter-exception",
        failureMessageClass: "adapter",
        outcome: REPLAY_PREVIEW_FAILURE.RETRY_EXHAUSTED,
        status: "completed",
        retryAt: null,
      });
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
      ).toHaveLength(1);
      const next = await restart().previewBatch(source, null);
      if (next.type !== "reserved") {
        throw new TypeError("Expected later preview after poison row");
      }
      expect(next.batch.decisionId).toBe(ids[1]);
      await restart().advancePreview(next.batch);
      if (!terminal) {
        throw new TypeError("Expected exhausted preview receipt");
      }
      const { source: otherSource } = await fixture();
      const otherSourceReceipt = {
        ...terminal,
        id: `${otherSource.id}:2:${terminal.firstDecisionId}:dry-run`,
        sourceId: otherSource.id,
      };
      const otherVersionReceipt = {
        ...terminal,
        id: `${source.id}:3:${terminal.firstDecisionId}:dry-run`,
        parserVersionTo: 3,
      };
      await db
        .insert(caseLawReplayBatches)
        .values([otherSourceReceipt, otherVersionReceipt]);
      await restart().resetDryRunCursor(source);
      for (const untouched of [otherSourceReceipt, otherVersionReceipt]) {
        expect(
          (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.id, untouched.id))
          ).at(0),
        ).toEqual(untouched);
      }
      const reset = await restart().previewBatch(source, null);
      if (reset.type !== "reserved") {
        throw new TypeError(
          "Expected exhausted preview re-admission after reset",
        );
      }
      expect(reset.batch.decisionId).toBe(ids[0]);
      expect(
        (
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.id, receiptId))
        ).at(0),
      ).toMatchObject({
        attempts: 1,
        failed: 1,
        outcome: null,
      });
      const apply = await restart().reserveBatch(
        enrolled,
        new Date(clock).toISOString().slice(0, 10),
        verdict(),
      );
      if (apply.type !== "reserved") {
        throw new TypeError(
          "Expected apply admission unaffected by preview failure",
        );
      }
      expect(apply.batch.decisionId).toBe(ids[0]);
    });

    test("systemic preview failures never exhaust the cursor row beyond the retry bound", async () => {
      for (const code of [
        "stored-raw-read",
        "writer-retryable",
        "tick-deadline",
      ] as const) {
        const { source: enrolled, ids } = await fixture();
        const source = { ...enrolled, mode: "dry-run" } as const;
        let clock = Date.UTC(2026, 9, 1);
        const restart = () =>
          createBackgroundReplayStore({ db, now: () => clock });
        const rowFailures =
          code === "writer-retryable"
            ? BACKGROUND_REPLAY_LIMITS.maxRowAttempts - 1
            : 0;
        for (let attempt = 0; attempt < rowFailures; attempt++) {
          const preview = await restart().previewBatch(source, null);
          if (preview.type !== "reserved") {
            throw new TypeError("Expected preview before row failure");
          }
          expect(
            await restart().recordFailure(preview.batch, {
              ...replayFailure("adapter-exception"),
              healthyEvidence: "none",
              durationMs: 1,
              verdict: verdict(),
            }),
          ).toBe("retryable");
          clock += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        }
        for (
          let attempt = 0;
          attempt < BACKGROUND_REPLAY_LIMITS.maxRowAttempts + 2;
          attempt++
        ) {
          const preview = await restart().previewBatch(source, null);
          if (preview.type !== "reserved") {
            throw new TypeError("Expected due preview during systemic outage");
          }
          expect(preview.batch.decisionId).toBe(ids[0]);
          expect(
            await restart().recordFailure(preview.batch, {
              ...replayFailure(code),
              healthyEvidence: "none",
              durationMs: 1,
              verdict: verdict(),
            }),
          ).toBe("retryable");
          const receipt = (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.id, preview.batch.id))
          ).at(0);
          expect(receipt).toMatchObject({
            attempts: rowFailures,
            outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
          });
          expect(await restart().previewBatch(source, null)).toEqual({
            type: "waiting",
          });
          clock += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        }
        const recovered = await restart().previewBatch(source, null);
        if (recovered.type !== "reserved") {
          throw new TypeError("Expected preview after systemic recovery");
        }
        expect(recovered.batch.decisionId).toBe(ids[0]);
        await restart().advancePreview(recovered.batch);
        const next = await restart().previewBatch(source, null);
        if (next.type !== "reserved") {
          throw new TypeError("Expected later preview after systemic recovery");
        }
        expect(next.batch.decisionId).toBe(ids[1]);
      }
    });

    test("transient previews keep their cursor until success at every attempt below the bound", async () => {
      for (
        let succeedsAt = 2;
        succeedsAt < BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
        succeedsAt++
      ) {
        const { source: enrolled, ids } = await fixture();
        const source = { ...enrolled, mode: "dry-run" } as const;
        let clock = Date.UTC(2026, 9, 1);
        const restart = () =>
          createBackgroundReplayStore({ db, now: () => clock });
        for (let attempt = 1; attempt <= succeedsAt; attempt++) {
          const preview = await restart().previewBatch(source, null);
          if (preview.type !== "reserved") {
            throw new TypeError("Expected due transient preview");
          }
          expect(preview.batch.decisionId).toBe(ids[0]);
          if (attempt === succeedsAt) {
            await restart().advancePreview(preview.batch);
            continue;
          }
          expect(
            await restart().recordFailure(preview.batch, {
              ...replayFailure("adapter-exception"),
              healthyEvidence: "none",
              durationMs: 1,
              verdict: verdict(),
            }),
          ).toBe("retryable");
          expect(await restart().previewBatch(source, null)).toEqual({
            type: "waiting",
          });
          clock += BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs;
        }
        const next = await restart().previewBatch(source, null);
        if (next.type !== "reserved") {
          throw new TypeError("Expected preview after transient recovery");
        }
        expect(next.batch.decisionId).toBe(ids[1]);
        const receipts = await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id));
        expect(
          receipts.find((row) => row.firstDecisionId === ids[0]),
        ).toMatchObject({ failed: 0, attempts: succeedsAt, retryAt: null });
      }
    });

    test("compaction generation retires never-reserved-again receipts while preserving the latest generation", async () => {
      const { source, store } = await fixture();
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      if (reserved.type !== "reserved") {
        throw new TypeError("Expected receipt fixture");
      }
      await persistParsedFixture(reserved.batch);
      expect(
        await store.completeBatch(reserved.batch, applied(reserved.batch)),
      ).toBe("applied");
      await db
        .update(caseLawReplayBatches)
        .set({ completedAt: new Date(Date.UTC(2025, 0, 1)) })
        .where(eq(caseLawReplayBatches.id, reserved.batch.id));
      expect(await store.compact()).toBe(0);
      await db.insert(caseLawReplayBatches).values({
        id: `${reserved.batch.id}:new`,
        sourceId: source.id,
        firstDecisionId: reserved.batch.decisionId,
        lastDecisionId: reserved.batch.decisionId,
        parserVersionTo: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
        budgetDay: "2026-10-01",
        status: "completed",
        attempted: 1,
        applied: 1,
        gateVerdict: verdict(),
      });
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
        .where(eq(caseLawSources.id, source.id));
      expect(await store.compact()).toBe(1);
      expect(
        await db
          .select()
          .from(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.batchId, reserved.batch.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id)),
      ).toHaveLength(1);
      await db
        .update(caseLawSources)
        .set({ adapterKey: `fixture-${source.id}` })
        .where(eq(caseLawSources.id, source.id));
    });

    test("audit retention prunes a bounded old page and preserves recent observations", async () => {
      const { source, store } = await fixture();
      await db.insert(caseLawReplayAuditEvents).values([
        {
          id: `old-audit-${source.id}`,
          sourceId: source.id,
          serviceId: "case-law-background-replay",
          action: "tick-recorded",
          resourceId: source.id,
          details: {},
          createdAt: new Date(Date.UTC(2025, 0, 1)),
        },
        {
          id: `new-audit-${source.id}`,
          sourceId: source.id,
          serviceId: "case-law-background-replay",
          action: "tick-recorded",
          resourceId: source.id,
          details: {},
          createdAt: new Date(Date.UTC(2026, 9, 1)),
        },
      ]);
      expect(await store.compact(1)).toBe(0);
      const retained = await db
        .select()
        .from(caseLawReplayAuditEvents)
        .where(eq(caseLawReplayAuditEvents.sourceId, source.id));
      expect(retained.map(({ id }) => id)).toEqual([`new-audit-${source.id}`]);
    });

    test("a tick that changed rows records one system audit run and an idle tick none", async () => {
      const { source, store } = await fixture();
      const replayRuns = async () =>
        await db
          .select()
          .from(systemAuditRuns)
          .where(
            eq(systemAuditRuns.actor, "system:case-law-background-replay"),
          );
      const before = (await replayRuns()).length;
      await store.recordTick({
        source,
        status: "row-limit",
        attempted: 3,
        applied: 2,
        blocked: 1,
        errors: 0,
        failed: 0,
        heldTooLong: false,
        retryExhausted: 0,
        retryTerminal: 0,
      });
      const after = await replayRuns();
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)?.counts).toEqual({
        attempted: 3,
        applied: 2,
        blocked: 1,
        failed: 0,
      });
      await store.recordTick({
        source,
        status: "empty",
        attempted: 0,
        applied: 0,
        blocked: 0,
        errors: 0,
        failed: 0,
        heldTooLong: false,
        retryExhausted: 0,
        retryTerminal: 0,
      });
      expect(await replayRuns()).toHaveLength(before + 1);
    });

    test("no-progress ticks survive process restarts and only verified applies reset them", async () => {
      const { source, store } = await fixture();
      const report = {
        source,
        status: "row-limit",
        attempted: 1,
        applied: 0,
        blocked: 1,
        errors: 0,
        failed: 0,
        heldTooLong: false,
        retryExhausted: 0,
        retryTerminal: 0,
      } as const;
      expect((await store.recordTick(report))?.ticksWithoutProgress).toBe(1);
      const restarted = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
      });
      expect((await restarted.recordTick(report))?.ticksWithoutProgress).toBe(
        2,
      );
      expect(
        (
          await restarted.recordTick({
            ...report,
            status: "held",
            attempted: 0,
          })
        )?.ticksWithoutProgress,
      ).toBe(2);
      expect(
        (
          await restarted.recordTick({
            ...report,
            status: "budget-exhausted",
            errors: 1,
          })
        )?.ticksWithoutProgress,
      ).toBe(3);
      expect(
        await restarted.recordTick({ ...report, applied: 1 }),
      ).toMatchObject({
        ticksWithoutProgress: 0,
        lastCompletedAt: new Date(Date.UTC(2026, 9, 1)),
      });
    });
    test("held source selection performs no decision scan even while the corpus table is locked", async () => {
      const { source } = await fixture();
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
        .where(eq(caseLawSources.id, source.id));
      const actual = {
        ...source,
        currentParserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
      };
      sources.push(actual);
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: {
          mode: "enrolled",

          reviewedDryRun: "fixture",
        },
      } as const;
      const held: BackgroundReplaySource[] = [];
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        onHeld: (row) => {
          held.push(row);
        },
      });
      await store.saveGateState(actual, {
        ...(await store.loadGateState(actual)),
        holdUntil: Date.UTC(2026, 9, 2),
      });
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        await openClient().db.transaction(async (lockTx) => {
          await lockTx.execute(
            sql`LOCK TABLE case_law_decisions IN ACCESS EXCLUSIVE MODE`,
          );
          expect(await store.chooseSource()).toBeNull();
          expect(held.map(({ id }) => id)).toEqual([source.id]);
        });
      });
      await db
        .update(caseLawSources)
        .set({ adapterKey: `fixture-${source.id}` })
        .where(eq(caseLawSources.id, source.id));
    });

    test("source progress is forced owner-only and the database rejects unclassified failures", async () => {
      const { source, store } = await fixture();
      const row = await store.reserveBatch(source, "2026-10-01", verdict());
      if (row.type !== "reserved") {
        throw new TypeError("Expected failure fixture");
      }
      const invalid = await Result.tryPromise(async () => {
        await db.execute(
          sql`UPDATE case_law_replay_batches SET failure_code = 'unclassified' WHERE id = ${row.batch.id}`,
        );
      });
      expect(Result.isError(invalid)).toBe(true);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const restricted = openClient().db;
        const denied = await Result.tryPromise(
          async () =>
            await restricted.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL ROLE stella`);
              await tx
                .select()
                .from(caseLawReplaySourceProgress)
                .where(eq(caseLawReplaySourceProgress.sourceId, source.id));
            }),
        );
        expect(Result.isError(denied)).toBe(true);
      });
      const rls = await db
        .select({
          forced: sql<boolean>`relforcerowsecurity`,
          enabled: sql<boolean>`relrowsecurity`,
        })
        .from(sql`pg_class`)
        .where(sql`oid = 'public.case_law_replay_source_progress'::regclass`);
      expect(rls.at(0)).toEqual({ forced: true, enabled: true });
    });

    test("actual compaction query scans only the indexed superseded retention page at production scale", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const ids = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted(compareCodeUnit);
      const rolledBack = await Result.tryPromise(
        async () =>
          await db.transaction(async (tx) => {
            const ownerRole = `replay_retention_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
            const fixtureSchema = `replay_retention_${Bun.randomUUIDv7().replaceAll("-", "")}`;
            await tx.execute(
              sql.raw(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
              GRANT ${ownerRole} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
              GRANT SELECT ON public.case_law_sources, public.case_law_replay_batches TO ${ownerRole};
              CREATE SCHEMA ${fixtureSchema} AUTHORIZATION ${ownerRole};
              SET LOCAL ROLE ${ownerRole};
              SET LOCAL search_path TO ${fixtureSchema}, public;
              CREATE TABLE case_law_sources (LIKE public.case_law_sources INCLUDING ALL);
              CREATE TABLE case_law_replay_batches (LIKE public.case_law_replay_batches INCLUDING ALL);
              DROP INDEX case_law_replay_batches_source_id_parser_version_to_id_idx;
              DROP INDEX case_law_replay_batches_superseded_at_id_idx;
              CREATE INDEX case_law_replay_batches_retire_idx ON case_law_replay_batches (source_id, parser_version_to, id)
                WHERE superseded_at IS NULL AND status IN ('completed', 'superseded', 'failed', 'retry-exhausted', 'retry-terminal', 'blocked');
              CREATE INDEX case_law_replay_batches_retention_idx ON case_law_replay_batches (superseded_at, id)
                WHERE superseded_at IS NOT NULL`),
            );
            const posture = await tx.execute<{
              superuser: boolean;
              bypass: boolean;
            }>(
              sql`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
            );
            expect(posture.at(0)).toEqual({ superuser: false, bypass: false });
            await tx.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name)
              VALUES (${sourceId}, ${ADAPTER_KEYS.EU_ECJ}, 'replay retention fixture')`);
            for (const [index, id] of ids.entries()) {
              await tx.execute(sql`INSERT INTO case_law_replay_batches
                (id, source_id, first_decision_id, last_decision_id, parser_version_to, budget_day, status, attempted, gate_verdict, superseded_at)
                VALUES (${`retention-${id}`}, ${sourceId}, ${id}, ${id}, 2, '2026-10-01', 'completed', 1, ${verdict()}, ${index === 0 ? new Date(Date.UTC(2025, 0, 1)) : null})`);
            }
            await tx.execute(sql`ANALYZE case_law_replay_batches`);
            await scaleTableToProfile(tx, "case_law_replay_batches", {
              tables: {
                case_law_replay_batches:
                  SYNTHETIC_SCALE_PROFILE.tables.case_law_decisions,
              },
              attributes: [],
            });
            const retirement = buildReplayRetirementQuery(
              tx,
              BACKGROUND_REPLAY_LIMITS.maxCompactRows,
            );
            const retirementRoot = explainRoot(
              await tx.execute(
                sql`EXPLAIN (FORMAT JSON) ${retirement.getSQL()}`,
              ),
            );
            const retiringScans = scanOccurrences(retirementRoot).filter(
              ({ relation }) => relation === "case_law_replay_batches",
            );
            expect(retiringScans.length).toBeGreaterThan(0);
            expect(
              retiringScans.every(({ nodeType }) => nodeType.includes("Index")),
            ).toBe(true);
            expect(
              retiringScans.some(
                ({ index }) => index === "case_law_replay_batches_retire_idx",
              ),
            ).toBe(true);
            const query = buildCaseLawReplayCompactionQuery(tx, {
              cutoff: new Date(Date.UTC(2026, 6, 1)),
              limit: BACKGROUND_REPLAY_LIMITS.maxCompactRows,
            });
            const root = explainRoot(
              await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query.getSQL()}`),
            );
            const scans = scanOccurrences(root).filter(
              ({ relation }) => relation === "case_law_replay_batches",
            );
            expect(scans.length).toBeGreaterThan(0);
            expect(
              scans.every(({ nodeType }) => nodeType.includes("Index")),
            ).toBe(true);
            expect(
              scans.some(
                ({ index }) =>
                  index === "case_law_replay_batches_retention_idx",
              ),
            ).toBe(true);
            const cost = root["Total Cost"];
            expect(typeof cost).toBe("number");
            if (typeof cost !== "number") {
              throw new TypeError("Expected numeric retention plan cost");
            }
            expect(cost).toBeLessThan(10_000);
            throw new TypeError("restore compaction statistics");
          }),
      );
      expect(Result.isError(rolledBack)).toBe(true);
      if (Result.isError(rolledBack)) {
        expect(
          rolledBack.error instanceof Error
            ? rolledBack.error.message
            : JSON.stringify(rolledBack.error),
        ).toContain("restore compaction statistics");
      }
    });

    test("actual selector and probe remain indexed and bounded under sparse and full synthetic corpus lag", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const fixtureIds = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted(compareCodeUnit);
      const end = toSafeId<"caseLawDecision">(
        "ffffffff-ffff-4fff-bfff-ffffffffffff",
      );
      const rolledBack = await Result.tryPromise(
        async () =>
          await db.transaction(async (tx) => {
            const ownerRole = `replay_plan_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
            const fixtureSchema = `replay_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
            await tx.execute(
              sql.raw(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
              GRANT ${ownerRole} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
              GRANT SELECT ON public.case_law_sources, public.case_law_decisions, public.case_law_replay_batches, public.case_law_replay_blocked TO ${ownerRole};
              CREATE SCHEMA ${fixtureSchema} AUTHORIZATION ${ownerRole};
              SET LOCAL ROLE ${ownerRole};
              SET LOCAL search_path TO ${fixtureSchema}, public;
              CREATE TABLE case_law_sources (LIKE public.case_law_sources INCLUDING ALL);
              CREATE TABLE case_law_decisions (LIKE public.case_law_decisions INCLUDING ALL);
              CREATE TABLE case_law_replay_batches (LIKE public.case_law_replay_batches INCLUDING ALL);
              CREATE TABLE case_law_replay_blocked (LIKE public.case_law_replay_blocked INCLUDING ALL);
              CREATE INDEX case_law_replay_blocked_source_version_idx ON case_law_replay_blocked (source_id, parser_version_to, decision_id)`),
            );
            const posture = await tx.execute<{
              superuser: boolean;
              bypass: boolean;
            }>(
              sql`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
            );
            expect(posture.at(0)).toEqual({ superuser: false, bypass: false });
            await tx.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name)
              VALUES (${sourceId}, ${ADAPTER_KEYS.EU_ECJ}, 'replay plan fixture')`);
            for (const [index, id] of fixtureIds.entries()) {
              await tx.execute(sql`INSERT INTO case_law_decisions
                (id, source_id, case_number, court, country, language, parser_version, source_raw_s3_key)
                VALUES (${id}, ${sourceId}, ${`store-${index}`}, 'fixture court', 'CZE', 'cs', 1, ${`fixture/${id}`})`);
            }
            await tx.execute(sql`INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language, parser_version, source_raw_s3_key)
              SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${sourceId}, 'plan-' || n::text, 'fixture court', 'CZE', 'cs', 2,
                CASE WHEN n % 2 = 0 THEN NULL ELSE 'fixture-plan' END
              FROM generate_series(1, 1000) AS series(n)`);
            await tx.execute(sql`INSERT INTO case_law_replay_blocked (source_id, decision_id, source_raw_s3_key, parser_version_from, parser_version_to, outcome, reason, detail)
              SELECT ${sourceId}, id, source_raw_s3_key, 1, 2, 'rejected', 'missing-payload', 'synthetic blocked fixture'
              FROM case_law_decisions WHERE source_id = ${sourceId} AND case_number LIKE 'plan-%'`);
            // Enrolment will ship these corpus indexes; the dormant feature
            // creates them only inside this rolled-back planner fixture.
            await tx.execute(
              sql`CREATE INDEX IF NOT EXISTS case_law_decisions_replay_sparse_idx ON case_law_decisions (source_id, parser_version, id) WHERE redacted_at IS NULL AND source_raw_s3_key IS NOT NULL`,
            );
            await tx.execute(
              sql`CREATE INDEX IF NOT EXISTS case_law_decisions_replay_walk_idx ON case_law_decisions (source_id, id, parser_version) WHERE redacted_at IS NULL AND source_raw_s3_key IS NOT NULL`,
            );
            await tx.execute(sql`ANALYZE case_law_decisions`);
            await tx.execute(sql`ANALYZE case_law_replay_blocked`);
            await scaleTableToProfile(tx, "case_law_replay_blocked", {
              tables: {
                case_law_replay_blocked:
                  SYNTHETIC_SCALE_PROFILE.tables.case_law_decisions,
              },
              attributes: [],
              scaleRelationPages: true,
            });
            await tx.execute(
              sql`SELECT pg_clear_attribute_stats(current_schema()::text, 'case_law_replay_blocked', 'source_id', false)`,
            );
            await tx.execute(sql`SELECT pg_restore_attribute_stats(
              'schemaname', current_schema()::text, 'relname', 'case_law_replay_blocked',
              'attname', 'source_id', 'inherited', false, 'null_frac', 0::real, 'n_distinct', -1::real
            )`);
            await scaleTableToProfile(tx, "case_law_decisions", {
              ...SYNTHETIC_SCALE_PROFILE,
              scaleRelationPages: true,
            });
            await tx.execute(
              sql`SELECT pg_clear_attribute_stats(current_schema()::text, 'case_law_decisions', 'source_id', false)`,
            );
            await tx.execute(sql`SELECT pg_restore_attribute_stats(
              'schemaname', current_schema()::text, 'relname', 'case_law_decisions',
              'attname', 'source_id', 'inherited', false, 'null_frac', 0::real, 'n_distinct', 100::real
            )`);
            for (const lag of ["sparse", "all"] as const) {
              const frequencies =
                lag === "sparse" ? [0.00001, 0.99999] : [0.99999, 0.00001];
              await tx.execute(sql`SELECT pg_restore_attribute_stats(
            'schemaname', current_schema()::text, 'relname', 'case_law_decisions',
            'attname', 'parser_version', 'inherited', false, 'null_frac', 0::real, 'n_distinct', 2::real,
            'most_common_vals', '{1,2}', 'most_common_freqs', ARRAY[${frequencies.at(0)}::real, ${frequencies.at(1)}::real]::real[]
          )`);
              const queries = [
                buildReplayScopeEndQuery(tx, {
                  sourceId,
                  scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
                  selection: {
                    type: "background",
                    currentParserVersion: 2,
                    mode: "enrolled",
                  },
                }),
                buildBackgroundReplayProbe(tx, {
                  mode: "enrolled",
                  sourceId,
                  currentParserVersion: 2,
                }),
                buildReplayPageQuery(tx, {
                  sourceId,
                  scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
                  selection: {
                    type: "background",
                    currentParserVersion: 2,
                    mode: "enrolled",
                  },
                  after: null,
                  until: end,
                  limit: 1,
                }),
              ];
              for (const query of queries) {
                const root = explainRoot(
                  await tx.execute(
                    sql`EXPLAIN (FORMAT JSON) ${query.getSQL()}`,
                  ),
                );
                const decisions = scanOccurrences(root).filter(
                  ({ relation }) => relation === "case_law_decisions",
                );
                expect(decisions.length).toBeGreaterThan(0);
                expect(decisions.filter(({ index }) => index === null)).toEqual(
                  [],
                );
                // The walker attributes bitmap index descendants to their heap
                // scan; requiring those names also rejects sequential scans.
                expect(
                  decisions.flatMap(({ index }) => index?.split(", ") ?? []),
                ).toEqual(
                  expect.arrayContaining([
                    expect.stringMatching(
                      /^case_law_decisions_replay_(sparse|walk)_idx$/u,
                    ),
                  ]),
                );
                const blocked = scanOccurrences(root).filter(
                  ({ relation }) => relation === "case_law_replay_blocked",
                );
                expect(blocked.length).toBeGreaterThan(0);
                expect(blocked.filter(({ index }) => index === null)).toEqual(
                  [],
                );
                const cost = root["Total Cost"];
                expect(typeof cost).toBe("number");
                if (typeof cost !== "number") {
                  throw new TypeError("Expected numeric synthetic plan cost");
                }
                expect(cost).toBeLessThan(10_000);
              }
            }
            throw new TypeError("restore synthetic plan statistics");
          }),
      );
      expect(Result.isError(rolledBack)).toBe(true);
      if (Result.isError(rolledBack)) {
        expect(
          rolledBack.error instanceof Error
            ? rolledBack.error.message
            : JSON.stringify(rolledBack.error),
        ).toContain("restore synthetic plan statistics");
      }
    });
  });
}
