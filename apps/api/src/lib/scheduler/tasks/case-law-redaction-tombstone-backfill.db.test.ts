/**
 * Historical redaction repair must erase every readable projection in the
 * same transaction as the canonical tombstone. Runs in the nightly Postgres
 * job; skipped elsewhere.
 */

import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSearchDocuments,
  caseLawSources,
  relations,
  schedulerJobs,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  backfillCaseLawRedactionTombstones,
} from "./case-law-redaction-tombstone-backfill";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law redaction tombstone backfill", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("case-law redaction tombstone backfill", () => {
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });
    const suffix = Bun.randomUUIDv7();
    const schedulerJobId = `test.case-law-redaction-backfill.${suffix}`;
    const leaseToken = `test-lease-${suffix}`;
    let sourceId = createSafeId<"caseLawSource">();

    const runTask = async () => {
      const job = await db.query.schedulerJobs.findFirst({
        where: { id: { eq: schedulerJobId } },
      });
      if (!job) {
        panic("expected scheduler job");
      }
      await backfillCaseLawRedactionTombstones({
        job,
        payload: job.payload,
        runId: createSafeId<"schedulerJobRun">(),
        signal: new AbortController().signal,
        logger,
      });
    };

    afterAll(async () => {
      await db
        .delete(schedulerJobs)
        .where(eq(schedulerJobs.id, schedulerJobId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    test("replays v1 rows, fences projection restoration, and reaches a fixed point", async () => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: `redaction-backfill-${suffix}`,
          enabled: false,
          name: "Redaction backfill test",
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        panic("expected source row");
      }
      sourceId = source.id;

      const [decision] = await db
        .insert(caseLawDecisions)
        .values({
          caseNumber: `redaction-backfill-${suffix}`,
          country: "CZE",
          court: "Test court",
          fulltext: "text that must no longer be searchable",
          language: "cs",
          sourceId,
        })
        .returning({ id: caseLawDecisions.id });
      if (!decision) {
        panic("expected decision row");
      }

      await db.insert(caseLawSearchDocuments).values({
        decisionId: decision.id,
        searchableText: "stale searchable text",
        title: "Stale title",
      });
      await db.insert(caseLawIndexJobs).values({
        decisionId: decision.id,
        generation: "case_law_v1",
        operation: "redact",
        status: "succeeded",
      });
      await db
        .update(caseLawDecisions)
        .set({ fulltext: null })
        .where(eq(caseLawDecisions.id, decision.id));
      await db.insert(schedulerJobs).values({
        description: "redaction repair test",
        id: schedulerJobId,
        lockedBy: leaseToken,
        nextRunAt: new Date("2026-08-01T00:00:00.000Z"),
        schedule: { type: "interval", everyMs: 60_000 },
        task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
      });

      await runTask();

      expect(
        await db.query.caseLawDecisions.findFirst({
          where: { id: { eq: decision.id } },
          columns: { fulltext: true, redactedAt: true },
        }),
      ).toMatchObject({ fulltext: null, redactedAt: expect.any(Date) });
      expect(
        await db
          .select({ id: caseLawSearchDocuments.decisionId })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, decision.id)),
      ).toHaveLength(0);

      const rejectedProjection = await db
        .insert(caseLawSearchDocuments)
        .values({
          decisionId: decision.id,
          searchableText: "attempted restored text",
          title: "Attempted restored title",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejectedProjection).toBeInstanceOf(Error);
      expect(
        await db
          .select({ id: caseLawSearchDocuments.decisionId })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, decision.id)),
      ).toHaveLength(0);

      const [raceDecision] = await db
        .insert(caseLawDecisions)
        .values({
          caseNumber: `redaction-race-${suffix}`,
          country: "CZE",
          court: "Test court",
          fulltext: "text from a stale projection writer",
          language: "cs",
          sourceId,
        })
        .returning({ id: caseLawDecisions.id });
      if (!raceDecision) {
        panic("expected race decision row");
      }

      let markRedactionReady: (() => void) | undefined;
      let releaseRedaction: (() => void) | undefined;
      const redactionReady = new Promise<void>((resolve) => {
        markRedactionReady = resolve;
      });
      const heldRedaction = db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ fulltext: null, redactedAt: new Date() })
          .where(eq(caseLawDecisions.id, raceDecision.id));
        markRedactionReady?.();
        await new Promise<void>((resolve) => {
          releaseRedaction = resolve;
        });
      });
      await redactionReady;

      const staleWriter = db
        .insert(caseLawSearchDocuments)
        .values({
          decisionId: raceDecision.id,
          searchableText: "attempted concurrent restoration",
          title: "Attempted concurrent restoration",
        })
        .then(
          () => "written" as const,
          () => "rejected" as const,
        );
      try {
        expect(
          await Promise.race([
            staleWriter,
            Bun.sleep(100).then(() => "blocked" as const),
          ]),
        ).toBe("blocked");
      } finally {
        releaseRedaction?.();
        await heldRedaction;
      }
      expect(await staleWriter).toBe("rejected");
      expect(
        await db
          .select({ id: caseLawSearchDocuments.decisionId })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, raceDecision.id)),
      ).toHaveLength(0);

      await runTask();

      expect(
        await db.query.schedulerJobs.findFirst({
          where: { id: { eq: schedulerJobId } },
          columns: { enabled: true },
        }),
      ).toEqual({ enabled: false });
    });
  });
}
