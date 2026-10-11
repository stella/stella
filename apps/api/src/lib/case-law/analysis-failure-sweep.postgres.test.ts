/**
 * The sweep a failure write runs over expired failure records must never
 * delete a record that another writer refreshed while the sweep waited on its
 * row lock: a deleted fresh record lets the next poll start a run its reader
 * never asked for. Concurrent writers need two real connections, so this runs
 * against Postgres in the gated job; PGlite serves one connection only. The
 * plain claim is held to the same standard: it must wait for an uncommitted
 * failure write on the decision row before reading failures.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import {
  caseLawAnalysisFailures,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  analysisFailureRecord,
  failureClaimGuard,
} from "./analysis-failure";
import { createDbAnalysisStore } from "./analysis-store-core";
import { analysisSentinel } from "./stored-analysis";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const FINGERPRINT = "f".repeat(64);
const KEY_TAG = "platform";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("analysis failure sweep under a concurrent refresh", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("analysis failure sweep under a concurrent refresh", () => {
    // Two pools: the refreshing transaction holds a connection of the first,
    // the sweep runs on the second, and the first's spare connection watches.
    const first = openGatedTestDatabase(databaseUrl, { max: 2 });
    const second = openGatedTestDatabase(databaseUrl, { max: 1 });
    const { db } = first;

    let sourceId: SafeId<"caseLawSource">;
    let createdSourceId: SafeId<"caseLawSource"> | null = null;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(-12);

    const insertDecision = async () => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `sweep-${created.length}-${suffix}`,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    beforeAll(async () => {
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          name: "SK courts analysis-failure sweep test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
      createdSourceId = source.id;
    });

    first.cleanUp(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
      if (createdSourceId !== null) {
        await db
          .delete(caseLawSources)
          .where(eq(caseLawSources.id, createdSourceId));
      }
    });

    test("a record refreshed while the sweep waits on its lock survives the sweep", async () => {
      const now = new Date();
      const expired = new Date(
        now.getTime() - ANALYSIS_FAILURE_HOLD_MS - 60_000,
      );
      const refreshedDecision = await insertDecision();
      const sweepingDecision = await insertDecision();
      await db.insert(caseLawAnalysisFailures).values({
        decisionId: refreshedDecision,
        keyTag: KEY_TAG,
        ...analysisFailureRecord({
          code: "failed",
          fingerprint: FINGERPRINT,
          now: expired,
          reader: { source: "platform" },
        }),
      });
      // The sweeping write is a failed run that still holds its row.
      const sentinel = analysisSentinel(FINGERPRINT, now);
      await db
        .update(caseLawDecisions)
        .set({ analysis: sentinel })
        .where(eq(caseLawDecisions.id, sweepingDecision));

      let sweep: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        // Connection one refreshes the expired record and holds its lock.
        await tx
          .update(caseLawAnalysisFailures)
          .set({ recordedAt: now })
          .where(eq(caseLawAnalysisFailures.decisionId, refreshedDecision));

        // Connection two records a failure, whose sweep selects the record
        // as expired and then waits on the lock.
        sweep = createDbAnalysisStore(second.db).fail({
          decisionId: sweepingDecision,
          keyTag: KEY_TAG,
          sentinel,
          failure: analysisFailureRecord({
            code: "timed_out",
            fingerprint: FINGERPRINT,
            now,
            reader: { source: "platform" },
          }),
        });

        // Commit only once the sweep is observably blocked on the lock.
        const blocked = async (): Promise<boolean> => {
          const rows = await db.execute<{ waiting: number }>(sql`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ILIKE '%DELETE FROM "case_law_analysis_failures"%'
          `);
          return (rows[0]?.waiting ?? 0) > 0;
        };
        const deadline = Date.now() + 10_000;
        while (!(await blocked())) {
          if (Date.now() > deadline) {
            throw new Error("the sweep never waited on the refreshed row");
          }
          await Bun.sleep(20);
        }
      });
      await sweep;

      const survivors = await db
        .select({ recordedAt: caseLawAnalysisFailures.recordedAt })
        .from(caseLawAnalysisFailures)
        .where(eq(caseLawAnalysisFailures.decisionId, refreshedDecision));
      expect(survivors).toEqual([{ recordedAt: now }]);
    });

    test("a plain claim that starts while a failure write is uncommitted waits for it and claims nothing", async () => {
      const now = new Date();
      const decisionId = await insertDecision();
      const reader = { source: "platform" } as const;
      const sentinel = analysisSentinel(FINGERPRINT, now);
      await db
        .update(caseLawDecisions)
        .set({ analysis: sentinel })
        .where(eq(caseLawDecisions.id, decisionId));

      let claim: Promise<unknown> | undefined;
      await db.transaction(async (tx) => {
        // Connection one: the failing run releases its sentinel and files its
        // failure, holding the decision row's lock until it commits.
        await createDbAnalysisStore(tx).fail({
          decisionId,
          keyTag: KEY_TAG,
          sentinel,
          failure: analysisFailureRecord({
            code: "timed_out",
            fingerprint: FINGERPRINT,
            now,
            reader,
          }),
        });

        // Connection two: a plain read that observed the run's marker as it
        // stood claims over it, and waits on the row lock the write holds.
        claim = createDbAnalysisStore(second.db).claimUnlessFailed({
          decisionId,
          fingerprint: FINGERPRINT,
          observed: sentinel,
          unlessFailed: failureClaimGuard({ decisionId, now, reader }),
        });

        const claimWaits = async (): Promise<boolean> => {
          const rows = await db.execute<{ waiting: number }>(sql`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%update "case_law_decisions"%'
          `);
          return (rows[0]?.waiting ?? 0) > 0;
        };
        const deadline = Date.now() + 10_000;
        while (!(await claimWaits())) {
          if (Date.now() > deadline) {
            throw new Error("the claim never waited on the decision row");
          }
          await Bun.sleep(20);
        }
      });

      expect(await claim).toMatchObject({ status: "ok", value: null });
      const [row] = await db
        .select({ analysis: caseLawDecisions.analysis })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      expect(row?.analysis ?? null).toBeNull();
    });
  });
}
