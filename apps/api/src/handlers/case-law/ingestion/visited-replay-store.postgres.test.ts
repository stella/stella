import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawReplayAuditEvents,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  caseLawReplayReportedDecisions,
  caseLawReplaySourceProgress,
  caseLawReplayVisitedQuotas,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { escapeLike } from "@/api/lib/escape-like";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import { createBackgroundReplayStore } from "./background-replay-store";
import { REPLAY_ENROLMENT } from "./replay-enrolment";
import {
  REPLAY_PRIORITY,
  VISITED_REPLAY_ADMISSION_LIMITS,
} from "./replay-priority";
import { createVisitedReplaySignals } from "./visited-replay";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("visited replay durable admission", () => {
    test("requires explicitly enabled Postgres", () =>
      expect(enabled && Boolean(databaseUrl)).toBe(false));
  });
} else {
  describe("visited replay durable admission", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceIds: SafeId<"caseLawSource">[] = [];
    cleanUp(async () => {
      for (const sourceId of sourceIds) {
        await db
          .delete(caseLawReplayAuditEvents)
          .where(eq(caseLawReplayAuditEvents.sourceId, sourceId));
        await db
          .delete(caseLawReplayReportedDecisions)
          .where(eq(caseLawReplayReportedDecisions.sourceId, sourceId));
        await db
          .delete(caseLawReplayVisitedQuotas)
          .where(eq(caseLawReplayVisitedQuotas.sourceId, sourceId));
        await db
          .delete(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, sourceId));
        await db
          .delete(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, sourceId));
        await db
          .delete(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, sourceId));
        await db
          .delete(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, sourceId));
        await db
          .delete(databaseBackfillStates)
          .where(
            like(
              databaseBackfillStates.name,
              `case-law-replay:${escapeLike(sourceId)}:%`,
            ),
          );
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
    const fixture = async (adapterKey: AdapterKey, count: number) => {
      const sourceId = createSafeId<"caseLawSource">();
      sourceIds.push(sourceId);
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey,
        name: "visited replay fixture",
        descriptor: {
          license: "public-domain",
          attribution: null,
          allowsRedistribution: true,
          allowsDerivedAi: true,
        },
      });
      const ids = Array.from({ length: count }, () =>
        createSafeId<"caseLawDecision">(),
      );
      await db.insert(caseLawDecisions).values(
        ids.map((id, index) => ({
          id,
          sourceId,
          caseNumber: `visited-${index}`,
          court: "Fixture court",
          country: "SVK",
          language: "sk",
          sourceHash: "a".repeat(64),
          sourceHashVersion: 1,
          parserVersion: 0,
          sourceRawS3Key: `fixture/raw/${id}`,
        })),
      );
      return {
        sourceId,
        ids,
        adapterKey,
        currentParserVersion: PARSER_VERSIONS[adapterKey],
      };
    };
    const store = createBackgroundReplayStore({ db, now: () => Date.now() });
    const readDb = Object.assign(
      async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
          const role = await tx.execute<{ role: string }>(
            sql`SELECT current_user AS role`,
          );
          expect(role.at(0)?.role).toBe("stella_public_law_reader");
          return await read(tx);
        }),
      caseLawPublicReadDb,
    );

    test("visited hints skip current and erased inputs, dedupe without charging, and elevate only to reported", async () => {
      const source = await fixture(ADAPTER_KEYS.EU_ECJ, 4);
      const [stale, current, erased, reported] = source.ids;
      if (!stale || !current || !erased || !reported) {
        panic("Expected visited admission fixtures");
      }
      await db
        .update(caseLawDecisions)
        .set({
          parserVersion: source.currentParserVersion,
          parsedSourceHash: caseLawDecisions.sourceHash,
          parsedSourceHashVersion: caseLawDecisions.sourceHashVersion,
          parsedSourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        })
        .where(eq(caseLawDecisions.id, current));
      await db
        .update(caseLawDecisions)
        .set({ sourceRawS3Key: null })
        .where(eq(caseLawDecisions.id, erased));
      const disabled = createBackgroundReplayStore({
        db,
        now: () => Date.now(),
        sourceEnabled: () => false,
      });
      expect(
        await disabled.enqueueVisitedDecisions({
          sourceId: source.sourceId,
          decisionIds: [stale],
        }),
      ).toEqual({ type: "unavailable" });
      expect(
        await db
          .select()
          .from(caseLawReplayReportedDecisions)
          .where(eq(caseLawReplayReportedDecisions.sourceId, source.sourceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(caseLawReplayVisitedQuotas)
          .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId)),
      ).toHaveLength(0);

      const candidates = await Promise.all(
        [stale, current, erased, stale].map(async (decisionId) => {
          const read = await withRedistributableSubject(
            readDb,
            "pages",
            { kind: "id", id: decisionId },
            async (subject) => await readDecisionHandler({ subject }),
          );
          if (read === null || !("documentPending" in read)) {
            panic("Expected a readable canonical decision");
          }
          return { sourceId: read.source.id, decisionId: read.id };
        }),
      );
      const buffer = createVisitedReplaySignals({
        usesLocalCorpus: () => true,
      });
      for (const candidate of candidates) {
        buffer.offer(candidate);
      }
      const admissions: Awaited<
        ReturnType<typeof store.enqueueVisitedDecisions>
      >[] = [];
      await buffer.flush({
        readVerdict: async () => ({ kind: "normal", signals: [] }),
        readLatencyAdmission: () => ({
          status: "admit",
          p95Ms: 10,
          samples: 20,
        }),
        enqueueBatch: async (batch) => {
          const sourceId =
            batch.at(0)?.sourceId ?? panic("Expected buffered candidates");
          admissions.push(
            await store.enqueueVisitedDecisions({
              sourceId,
              decisionIds: batch.map(({ decisionId }) => decisionId),
            }),
          );
        },
        maxDurationMs: 1000,
      });
      expect(admissions).toEqual([
        { type: "queued", inserted: 1, deferred: 2 },
      ]);
      expect(
        await store.enqueueVisitedDecisions({
          sourceId: source.sourceId,
          decisionIds: [stale, current],
        }),
      ).toEqual({ type: "queued", inserted: 0, deferred: 2 });
      expect(
        (
          await db
            .select()
            .from(caseLawReplayVisitedQuotas)
            .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId))
        ).at(0)?.admittedRows,
      ).toBe(1);
      await store.enqueueVisitedDecisions({
        sourceId: source.sourceId,
        decisionIds: [reported],
      });
      await store.enqueueReportedDecision({
        sourceId: source.sourceId,
        decisionId: reported,
        targetParserVersion: source.currentParserVersion,
      });
      expect(
        (
          await db
            .select()
            .from(caseLawReplayReportedDecisions)
            .where(
              and(
                eq(caseLawReplayReportedDecisions.sourceId, source.sourceId),
                eq(caseLawReplayReportedDecisions.decisionId, reported),
              ),
            )
        ).at(0)?.tier,
      ).toBe(REPLAY_PRIORITY.REPORTED);
      await store.enqueueVisitedDecisions({
        sourceId: source.sourceId,
        decisionIds: [reported],
      });
      expect(
        (
          await db
            .select()
            .from(caseLawReplayReportedDecisions)
            .where(eq(caseLawReplayReportedDecisions.decisionId, reported))
        ).at(0)?.tier,
      ).toBe(REPLAY_PRIORITY.REPORTED);
      const reserved = await store.reserveBatch(
        {
          id: source.sourceId,
          adapterKey: source.adapterKey,
          currentParserVersion: source.currentParserVersion,
          mode: "enrolled",
          rowsBehind: 1,
        },
        "2026-10-29",
        { kind: "normal", signals: [] },
      );
      if (reserved.type !== "reserved") {
        panic("Expected priority reservation");
      }
      expect(reserved.batch.decisionId).toBe(reported);
      expect(
        (
          await db
            .select()
            .from(caseLawReplayVisitedQuotas)
            .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId))
        ).at(0)?.admittedRows,
      ).toBe(2);
    });

    test("source admission holds an enrolled parser bump until its matching version was reviewed", async () => {
      const source = await fixture(ADAPTER_KEYS.EU_ECJ, 1);
      const policy = {
        mode: "enrolled",
        reviewedParserVersion: source.currentParserVersion - 1,
        reviewedDryRun: "fixture",
      } as const;
      const recording = installRecordingLogger();
      try {
        const held = createBackgroundReplayStore({
          db,
          now: () => Date.now(),
          enrolment: { ...REPLAY_ENROLMENT, [ADAPTER_KEYS.EU_ECJ]: policy },
          sourceEnabled: (key) => key === source.adapterKey,
        });
        expect(await held.chooseSource()).toBeNull();
        expect(
          recording.records.some(
            (record) =>
              record.message === "case_law_replay.wave_held" &&
              record.attributes?.["reason"] === "unreviewed-parser-version",
          ),
        ).toBe(true);
        const reviewed = createBackgroundReplayStore({
          db,
          now: () => Date.now(),
          enrolment: {
            ...REPLAY_ENROLMENT,
            [ADAPTER_KEYS.EU_ECJ]: {
              ...policy,
              reviewedParserVersion: source.currentParserVersion,
            },
          },
          sourceEnabled: (key) => key === source.adapterKey,
        });
        expect((await reviewed.chooseSource())?.id).toBe(source.sourceId);
        const preview = createBackgroundReplayStore({
          db,
          now: () => Date.now(),
          enrolment: {
            ...REPLAY_ENROLMENT,
            [ADAPTER_KEYS.EU_ECJ]: { mode: "dry-run" },
          },
          sourceEnabled: (key) => key === source.adapterKey,
        });
        expect((await preview.chooseSource())?.mode).toBe("dry-run");
      } finally {
        recording.restore();
      }
    });

    test("two independent store instances share the source minute ceiling and duplicates spend no quota", async () => {
      const source = await fixture(ADAPTER_KEYS.CZ_NSS, 90);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.now(),
        });
        const second = createBackgroundReplayStore({
          db: openClient().db,
          now: () => Date.now(),
        });
        const results = await Promise.all([
          first.enqueueVisitedDecisions({
            sourceId: source.sourceId,
            decisionIds: source.ids.slice(0, 64),
          }),
          second.enqueueVisitedDecisions({
            sourceId: source.sourceId,
            decisionIds: source.ids.slice(26),
          }),
        ]);
        expect(results.every((result) => result.type === "queued")).toBe(true);
        const windows = await db.execute<{ count: number }>(
          sql`SELECT count(*)::integer AS count FROM ${caseLawReplayReportedDecisions} WHERE ${caseLawReplayReportedDecisions.sourceId} = ${source.sourceId} GROUP BY date_trunc('minute', ${caseLawReplayReportedDecisions.queuedAt})`,
        );
        expect(windows.length).toBeGreaterThan(0);
        for (const window of windows) {
          expect(window.count).toBeLessThanOrEqual(
            VISITED_REPLAY_ADMISSION_LIMITS.rowsPerSourceMinute,
          );
        }
        const quotaBefore = (
          await db
            .select()
            .from(caseLawReplayVisitedQuotas)
            .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId))
        ).at(0);
        const alreadyQueued = await db
          .select({ id: caseLawReplayReportedDecisions.decisionId })
          .from(caseLawReplayReportedDecisions)
          .where(eq(caseLawReplayReportedDecisions.sourceId, source.sourceId));
        const repeated = await first.enqueueVisitedDecisions({
          sourceId: source.sourceId,
          decisionIds: alreadyQueued.slice(0, 64).map(({ id }) => id),
        });
        expect(repeated.type).toBe("queued");
        if (repeated.type === "queued") {
          expect(repeated.inserted).toBe(0);
        }
        const quotaAfter = (
          await db
            .select()
            .from(caseLawReplayVisitedQuotas)
            .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId))
        ).at(0);
        if (
          quotaBefore?.windowStartedAt.getTime() ===
          quotaAfter?.windowStartedAt.getTime()
        ) {
          expect(quotaAfter?.admittedRows).toBe(quotaBefore?.admittedRows);
        }
      });
    });

    test("due reported recovery outranks visited hints while future retries and current ghosts yield", async () => {
      const reported = await fixture(ADAPTER_KEYS.EU_ECJ, 1);
      const visited = await fixture(ADAPTER_KEYS.CZ_NSS, 1);
      const reportedId =
        reported.ids.at(0) ?? panic("Expected reported recovery fixture");
      await db.insert(caseLawReplaySourceProgress).values(
        [reported, visited].map((source) => ({
          sourceId: source.sourceId,
          lastFullReplayParserVersion: source.currentParserVersion,
        })),
      );
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: {
          mode: "enrolled",
          reviewedParserVersion: reported.currentParserVersion,
          reviewedDryRun: "fixture",
        },
        [ADAPTER_KEYS.CZ_NSS]: {
          mode: "enrolled",
          reviewedParserVersion: visited.currentParserVersion,
          reviewedDryRun: "fixture",
        },
      } as const;
      const prioritised = createBackgroundReplayStore({
        db,
        now: () => Date.now(),
        enrolment,
        sourceEnabled: (key) =>
          key === reported.adapterKey || key === visited.adapterKey,
      });
      await prioritised.enqueueReportedDecision({
        sourceId: reported.sourceId,
        decisionId: reportedId,
        targetParserVersion: reported.currentParserVersion,
      });
      await prioritised.enqueueVisitedDecisions({
        sourceId: visited.sourceId,
        decisionIds: visited.ids,
      });
      const reservation = await prioritised.reserveBatch(
        {
          id: reported.sourceId,
          adapterKey: reported.adapterKey,
          currentParserVersion: reported.currentParserVersion,
          mode: "enrolled",
          rowsBehind: 1,
        },
        "2026-10-29",
        { kind: "normal", signals: [] },
      );
      if (reservation.type !== "reserved") {
        panic("Expected reported recovery reservation");
      }
      expect((await prioritised.chooseSource())?.id).toBe(reported.sourceId);
      await db
        .update(caseLawReplayBatches)
        .set({ retryAt: sql`clock_timestamp() + interval '1 hour'` })
        .where(eq(caseLawReplayBatches.id, reservation.batch.id));
      expect((await prioritised.chooseSource())?.id).toBe(visited.sourceId);
      await db
        .update(caseLawReplayBatches)
        .set({ retryAt: null })
        .where(eq(caseLawReplayBatches.id, reservation.batch.id));
      await db
        .update(caseLawDecisions)
        .set({
          parserVersion: reported.currentParserVersion,
          parsedSourceHash: caseLawDecisions.sourceHash,
          parsedSourceHashVersion: caseLawDecisions.sourceHashVersion,
          parsedSourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        })
        .where(eq(caseLawDecisions.id, reportedId));
      expect((await prioritised.chooseSource())?.id).toBe(reported.sourceId);
      await db
        .update(caseLawReplayBatches)
        .set({ status: "completed", applied: 1 })
        .where(eq(caseLawReplayBatches.id, reservation.batch.id));
      expect((await prioritised.chooseSource())?.id).toBe(visited.sourceId);
    });

    test("compaction bounds stale quota and completed hint cleanup while retaining pending hints", async () => {
      const source = await fixture(ADAPTER_KEYS.EU_ECJ, 3);
      await store.enqueueVisitedDecisions({
        sourceId: source.sourceId,
        decisionIds: source.ids,
      });
      const [first, second, pending] = source.ids;
      if (!first || !second || !pending) {
        panic("Expected retention fixtures");
      }
      await db
        .update(caseLawReplayVisitedQuotas)
        .set({ windowStartedAt: sql`clock_timestamp() - interval '3 minutes'` })
        .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId));
      await db
        .update(caseLawReplayReportedDecisions)
        .set({ completedAt: sql`clock_timestamp() - interval '91 days'` })
        .where(
          and(
            eq(caseLawReplayReportedDecisions.sourceId, source.sourceId),
            sql`${caseLawReplayReportedDecisions.decisionId} IN (${first}::uuid, ${second}::uuid)`,
          ),
        );
      await store.compact(1);
      expect(
        await db
          .select()
          .from(caseLawReplayVisitedQuotas)
          .where(eq(caseLawReplayVisitedQuotas.sourceId, source.sourceId)),
      ).toHaveLength(0);
      const hints = await db
        .select()
        .from(caseLawReplayReportedDecisions)
        .where(eq(caseLawReplayReportedDecisions.sourceId, source.sourceId));
      expect(hints).toHaveLength(2);
      expect(
        hints.find((hint) => hint.decisionId === pending)?.completedAt,
      ).toBeNull();
      expect(hints.filter((hint) => hint.completedAt !== null)).toHaveLength(1);
    });

    test("source hints order reported before visited before pending parser waves", async () => {
      const reported = await fixture(ADAPTER_KEYS.EU_ECJ, 1);
      const visited = await fixture(ADAPTER_KEYS.CZ_NSS, 1);
      const bumped = await fixture(ADAPTER_KEYS.SK_COURTS, 1);
      const remaining = await fixture(ADAPTER_KEYS.PL_SN, 1);
      await db.insert(caseLawReplaySourceProgress).values(
        [reported, visited, remaining].map((source) => ({
          sourceId: source.sourceId,
          lastFullReplayParserVersion: source.currentParserVersion,
        })),
      );
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: {
          mode: "enrolled",
          reviewedParserVersion: reported.currentParserVersion,
          reviewedDryRun: "fixture",
        },
        [ADAPTER_KEYS.CZ_NSS]: {
          mode: "enrolled",
          reviewedParserVersion: visited.currentParserVersion,
          reviewedDryRun: "fixture",
        },
        [ADAPTER_KEYS.SK_COURTS]: {
          mode: "enrolled",
          reviewedParserVersion: bumped.currentParserVersion,
          reviewedDryRun: "fixture",
        },
        [ADAPTER_KEYS.PL_SN]: {
          mode: "enrolled",
          reviewedParserVersion: remaining.currentParserVersion,
          reviewedDryRun: "fixture",
        },
      } as const;
      const enabledSources = new Set([
        reported.adapterKey,
        visited.adapterKey,
        bumped.adapterKey,
        remaining.adapterKey,
      ]);
      const prioritised = createBackgroundReplayStore({
        db,
        now: () => Date.now(),
        enrolment,
        sourceEnabled: (key) => enabledSources.has(key),
      });
      await prioritised.enqueueVisitedDecisions({
        sourceId: reported.sourceId,
        decisionIds: reported.ids,
      });
      await prioritised.enqueueReportedDecision({
        sourceId: reported.sourceId,
        decisionId: reported.ids.at(0) ?? panic("Missing reported fixture"),
        targetParserVersion: reported.currentParserVersion,
      });
      await prioritised.enqueueVisitedDecisions({
        sourceId: visited.sourceId,
        decisionIds: visited.ids,
      });
      expect((await prioritised.chooseSource())?.id).toBe(reported.sourceId);
      await db
        .update(caseLawReplayReportedDecisions)
        .set({ completedAt: new Date() })
        .where(eq(caseLawReplayReportedDecisions.sourceId, reported.sourceId));
      expect((await prioritised.chooseSource())?.id).toBe(visited.sourceId);
      await db
        .update(caseLawReplayReportedDecisions)
        .set({ completedAt: new Date() })
        .where(eq(caseLawReplayReportedDecisions.sourceId, visited.sourceId));
      expect((await prioritised.chooseSource())?.id).toBe(bumped.sourceId);
      enabledSources.clear();
      enabledSources.add(remaining.adapterKey);
      expect((await prioritised.chooseSource())?.id).toBe(remaining.sourceId);
    });
  });
}
