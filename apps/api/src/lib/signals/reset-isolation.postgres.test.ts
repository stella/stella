import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import {
  SCOUT_RUN_STATUS,
  SIGNAL_EVENT_TYPE,
  scoutRuns,
  signalEvents,
  signals,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  cleanupScoutRuns as cleanupScoutRunsFacade,
  cleanupSignalEvents as cleanupSignalEventsFacade,
  cleanupSignals as cleanupSignalsFacade,
} from "@/api/lib/signals/reset-cleanup";
import {
  cleanupScoutRuns as cleanupScoutRunsOwner,
  cleanupSignalEvents as cleanupSignalEventsOwner,
  cleanupSignals as cleanupSignalsOwner,
} from "@/api/lib/signals/reset-cleanup-owner";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

const seedSignalRows = async (
  db: GatedTestDb,
  fixture: Awaited<ReturnType<typeof flowReviewGateFixture>>,
) => {
  const signalId = createSafeId<"signal">();
  await db.insert(scoutRuns).values({
    id: createSafeId<"scoutRun">(),
    organizationId: fixture.organizationId,
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    status: SCOUT_RUN_STATUS.SUCCEEDED,
    emittedCount: 1,
    insertedCount: 1,
    finishedAt: new Date(),
  });
  await db.insert(signals).values({
    id: signalId,
    organizationId: fixture.organizationId,
    workspaceId: fixture.workspaceId,
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    origin: SIGNAL_ORIGIN.MANUAL,
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.INFO,
    title: "Request fixture",
    summary: "Request fixture",
    subject: { type: "workspace", workspaceId: fixture.workspaceId },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: "Request fixture",
      attachments: [],
    },
    suggestions: [],
    dedupeKey: signalId,
    createdByUserId: fixture.userId,
  });
  await db.insert(signalEvents).values({
    id: createSafeId<"signalEvent">(),
    organizationId: fixture.organizationId,
    signalId,
    type: SIGNAL_EVENT_TYPE.CREATED,
    actorUserId: fixture.userId,
  });
};

const readSignalRows = async (
  db: GatedTestDb,
  organizationId: SafeId<"organization">,
) => ({
  runs: await db
    .select()
    .from(scoutRuns)
    .where(eq(scoutRuns.organizationId, organizationId))
    .orderBy(scoutRuns.id),
  events: await db
    .select()
    .from(signalEvents)
    .where(eq(signalEvents.organizationId, organizationId))
    .orderBy(signalEvents.id),
  signals: await db
    .select()
    .from(signals)
    .where(eq(signals.organizationId, organizationId))
    .orderBy(signals.id),
});

const paths = [
  {
    name: "scout census owner",
    cleanup: cleanupScoutRunsOwner,
    target: "scoutRuns",
  },
  {
    name: "scout census facade",
    cleanup: cleanupScoutRunsFacade,
    target: "scoutRuns",
  },
  {
    name: "signal event owner",
    cleanup: cleanupSignalEventsOwner,
    target: "signalEvents",
  },
  {
    name: "signal event facade",
    cleanup: cleanupSignalEventsFacade,
    target: "signalEvents",
  },
  {
    name: "signal owner",
    cleanup: cleanupSignalsOwner,
    target: "signalsRemoved",
  },
  {
    name: "signal facade",
    cleanup: cleanupSignalsFacade,
    target: "signalsRemoved",
  },
] as const;

describe.skipIf(!enabled)(
  "signal reset organization isolation (postgres)",
  () => {
    test.each(paths)(
      "$name retains other organizations' rows",
      async ({ cleanup, target }) => {
        await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
          const { db } = openClient();
          const a = await flowReviewGateFixture(db, { intermediate: false });
          const b = await flowReviewGateFixture(db, { intermediate: false });
          const subject = createSafeId<"schedulerJobRun">();
          try {
            await seedSignalRows(db, a);
            await seedSignalRows(db, b);
            const before = {
              rows: await readSignalRows(db, b.organizationId),
              source: await b.read(),
            };
            expect(before.rows.runs).toHaveLength(1);
            expect(before.rows.events).toHaveLength(1);
            expect(before.rows.signals).toHaveLength(1);
            await withAggregateTransaction(db, async (tx) => {
              await cleanup({ tx, organizationId: a.organizationId, subject });
            });
            expect({
              rows: await readSignalRows(db, b.organizationId),
              source: await b.read(),
            }).toEqual(before);
            const remaining = await readSignalRows(db, a.organizationId);
            expect(remaining.runs).toHaveLength(target === "scoutRuns" ? 0 : 1);
            expect(remaining.events).toHaveLength(
              target === "scoutRuns" ? 1 : 0,
            );
            expect(remaining.signals).toHaveLength(
              target === "signalsRemoved" ? 0 : 1,
            );
            const audit = await db
              .select({
                actor: systemAuditRuns.actor,
                counts: systemAuditRuns.counts,
              })
              .from(systemAuditRuns)
              .where(eq(systemAuditRuns.subject, subject));
            expect(audit).toEqual([
              {
                actor: "system:review-reset-signal-cleanup",
                counts: {
                  scoutRuns: target === "scoutRuns" ? 1 : 0,
                  signalEvents: target === "signalEvents" ? 1 : 0,
                  signalsRemoved: target === "signalsRemoved" ? 1 : 0,
                },
              },
            ]);
          } finally {
            await db
              .delete(systemAuditRuns)
              .where(eq(systemAuditRuns.subject, subject));
            await b.cleanup();
            await a.cleanup();
          }
        });
      },
    );
  },
);
