import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";
import { mapWithConcurrency } from "@stll/concurrency";
import { withTimeout } from "@stll/concurrency/with-timeout";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import { abortableTx, safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  documentReviewFindings,
  documentReviewRuns,
  entities,
  entityVersions,
  fields,
  properties,
  featureEnrolments,
  pendingScoutEmissions,
  notifications,
  scoutRuns,
  signals,
  workspaceMembers,
  workObligations,
  workspaces,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  findSignalsBackgroundActor,
  isBackgroundFeatureEnabled,
  loadBackgroundFeatureActors,
} from "@/api/lib/feature-access/background";
import { resumeFeatureAfterGrant } from "@/api/lib/feature-access/grant-recovery";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { clearMemberAssignments } from "@/api/lib/member-offboarding/member-assignment-offboarding-owner";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  RECOVER_SCOUT_EMISSION_TASK,
  recoverScoutEmission,
  resumeScoutEmissionAfterGrant,
} from "@/api/lib/scheduler/tasks/scout-emission-recovery";
import type { SchedulerJob } from "@/api/lib/scheduler/types";
import { pauseDocumentDeadlineScoutAfterGrantLoss } from "@/api/lib/scouts/document-deadline-recovery";
import { settleDocumentDeadlineScoutClaim } from "@/api/lib/scouts/document-deadlines";
import { runWorkAttentionScout } from "@/api/lib/scouts/work-attention";
import type { NewSignal } from "@/api/lib/signals/emit";
import { resumeSignalsAfterGrant } from "@/api/lib/signals/grant-recovery";
import { runScout } from "@/api/lib/signals/scout";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  emitDocumentReviewSignal,
  maybeEmitDocumentReviewSignal,
} from "./document-review";
import { maybeEmitDocumentReviewSignal as maybeEmitDocumentReviewSignalRecovery } from "./document-review-recovery";
import { emitInfoSoudHearingSignals } from "./infosoud-hearings";
import { emitInfoSoudHearingSignals as emitInfoSoudHearingSignalsRecovery } from "./infosoud-hearings-recovery";
import type { HearingRecord } from "./infosoud-hearings.logic";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const NOW = new Date("2030-01-01T12:00:00.000Z");
const CLAIM = new Date("2030-01-01T12:05:00.000Z");
const BASIS = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Replay playbook",
      positions: { version: 3, items: [] },
    },
  },
  references: [],
  perspective: { type: "neutral" },
} satisfies DocumentReviewRunBasis;
const HEARING = {
  externalId: "hearing-fixture",
  caseMark: "1 C 1/2030",
  court: "Fixture court",
  hearingType: "hearing",
  startAt: NOW,
  cancelled: false,
  date: "2030-01-01",
  time: "12:00",
} satisfies HearingRecord;

const fixtureFor = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const fileFieldId = createSafeId<"field">();
  const entityVersionId = createSafeId<"entityVersion">();
  const runId = createSafeId<"documentReviewRun">();
  const positionId = Bun.randomUUIDv7();
  await db.insert(organization).values({
    id: organizationId,
    name: "Direct emission fixture",
    slug: organizationId,
    createdAt: NOW,
  });
  await db.insert(user).values({
    id: userId,
    name: "Scout actor",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: NOW,
  });
  await db
    .insert(featureEnrolments)
    .values({ organizationId, userId, featureId: "signals" });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Scout matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    name: "review.pdf",
    createdBy: userId,
  });
  await db.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId,
    entityId,
  });
  const propertyId = createSafeId<"property">();
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "Source file",
    status: "fresh",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
  });
  await db.insert(fields).values({
    id: fileFieldId,
    workspaceId,
    entityVersionId,
    propertyId,
    content: { type: "pending", version: 1 },
  });
  await db.insert(documentReviewRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId,
    fileFieldId,
    entityVersionId,
    contentSha256: "a".repeat(64),
    basis: BASIS,
    requestedBy: userId,
    executor: "table",
    status: "running",
    total: 1,
  });
  await db.insert(documentReviewFindings).values({
    id: createSafeId<"documentReviewFinding">(),
    organizationId,
    workspaceId,
    runId,
    entityId,
    fileFieldId,
    entityVersionId,
    positionId,
    positionTitle: "Missing notice",
    outcome: "missing",
    payload: {
      finding: {
        positionId,
        issue: "Missing notice",
        severity: "high",
        standardSource: "tiers",
        verdict: "missing",
        delta: { kind: "language" },
        extracted: null,
        rationale: "Required notice is absent.",
        citations: [],
        fix: null,
      },
    },
  });
  return {
    organizationId,
    userId,
    workspaceId,
    entityId,
    fileFieldId,
    entityVersionId,
    runId,
  };
};

type Fixture = Awaited<ReturnType<typeof fixtureFor>>;
const isResumePath = (path: string) =>
  path === "scout-resume" ||
  path === "signals-resume" ||
  path === "feature-resume";
const readFixture = async (db: GatedTestDb, fixture: Fixture) => ({
  entity: await db.query.entities.findFirst({
    where: { id: { eq: fixture.entityId } },
  }),
  obligations: await db
    .select()
    .from(workObligations)
    .where(eq(workObligations.workspaceId, fixture.workspaceId))
    .orderBy(workObligations.entityId),
  run: (
    await db
      .select()
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.id, fixture.runId))
      .limit(1)
  ).at(0),
  findings: await db
    .select()
    .from(documentReviewFindings)
    .where(eq(documentReviewFindings.runId, fixture.runId))
    .orderBy(documentReviewFindings.id),
  receipts: await db
    .select()
    .from(pendingScoutEmissions)
    .where(eq(pendingScoutEmissions.organizationId, fixture.organizationId))
    .orderBy(pendingScoutEmissions.sourceKind, pendingScoutEmissions.sourceId),
  signals: await db
    .select()
    .from(signals)
    .where(eq(signals.organizationId, fixture.organizationId))
    .orderBy(signals.id),
  census: await db
    .select()
    .from(scoutRuns)
    .where(eq(scoutRuns.organizationId, fixture.organizationId))
    .orderBy(scoutRuns.id),
  notifications: await db
    .select()
    .from(notifications)
    .where(eq(notifications.organizationId, fixture.organizationId))
    .orderBy(notifications.id),
});
const cleanup = async (db: GatedTestDb, fixture: Fixture) => {
  await db
    .delete(organization)
    .where(eq(organization.id, fixture.organizationId));
  await db.delete(user).where(eq(user.id, fixture.userId));
};

const regrant = async (db: GatedTestDb, fixture: Fixture) =>
  await db.transaction(async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: fixture.organizationId,
      featureId: "signals",
    });
    await tx.insert(featureEnrolments).values({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      featureId: "signals",
    });
  });

const proposedFor = ({ workspaceId, entityId }: Fixture) =>
  ({
    kind: SIGNAL_KIND.HEARING_CHANGED,
    scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
    workspaceId,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title: "Hearing fixture",
    summary: "Hearing listed",
    subject: { type: "entity", workspaceId, entityId },
    evidence: {
      kind: SIGNAL_KIND.HEARING_CHANGED,
      courtName: HEARING.court,
      caseNumber: HEARING.caseMark,
      hearingType: HEARING.hearingType,
      previousAt: null,
      currentAt: NOW.toISOString(),
      sourceUrl: null,
    },
    suggestions: [],
    dedupeKey: `direct:${entityId}`,
  }) satisfies NewSignal;

describe.skipIf(!enabled)(
  "direct scout admission and receipt ownership (postgres)",
  () => {
    test.each([
      "review",
      "hearing",
      "scout-resume",
      "scout-recovery",
      "signals-resume",
      "feature-resume",
      "background",
      "work-attention",
    ] as const)(
      "%s owner preserves the other organization's sources",
      async (path) => {
        const previousSignals = env.FEATURE_SIGNALS;
        const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        testState.setConfig("FEATURE_SIGNALS", true);
        testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const { db } = openClient();
              const a = await fixtureFor(db);
              const b = await fixtureFor(db);
              try {
                await db.insert(member).values({
                  id: Bun.randomUUIDv7(),
                  organizationId: b.organizationId,
                  userId: a.userId,
                  role: "member",
                  createdAt: NOW,
                });
                await db
                  .insert(workspaceMembers)
                  .values({ workspaceId: b.workspaceId, userId: a.userId });
                await db.insert(featureEnrolments).values({
                  organizationId: b.organizationId,
                  userId: a.userId,
                  featureId: "signals",
                });
                await db
                  .update(documentReviewRuns)
                  .set({ requestedBy: a.userId })
                  .where(eq(documentReviewRuns.id, b.runId));
                await mapWithConcurrency({
                  items: [a, b],
                  limit: 1,
                  operation: async (f) =>
                    await withOrgScopedFixture({
                      database: db,
                      workspaceId: f.workspaceId,
                      fn: async (fixtureTx) =>
                        await fixtureTx.insert(pendingScoutEmissions).values({
                          organizationId: f.organizationId,
                          workspaceId: f.workspaceId,
                          sourceKind: "document-review",
                          sourceId: f.runId,
                          status: "awaiting_grant",
                          nextAttemptAt: NOW,
                        }),
                    }),
                });
                expect(
                  await isBackgroundFeatureEnabled({
                    tx: db,
                    organizationId: a.organizationId,
                    userId: a.userId,
                    featureId: "signals",
                  }),
                ).toBe(true);
                expect(
                  await isBackgroundFeatureEnabled({
                    tx: db,
                    organizationId: b.organizationId,
                    userId: a.userId,
                    featureId: "signals",
                  }),
                ).toBe(true);
                if (path === "work-attention" || path === "scout-recovery") {
                  await db
                    .delete(featureEnrolments)
                    .where(
                      eq(featureEnrolments.organizationId, b.organizationId),
                    );
                }
                if (path === "scout-recovery") {
                  await db
                    .update(documentReviewRuns)
                    .set({ status: "completed", completed: 1 })
                    .where(eq(documentReviewRuns.id, a.runId));
                }
                if (path === "work-attention") {
                  await db
                    .update(entities)
                    .set({ kind: "task" })
                    .where(
                      and(
                        eq(entities.workspaceId, a.workspaceId),
                        eq(entities.id, a.entityId),
                      ),
                    );
                  await db
                    .update(entities)
                    .set({ kind: "task" })
                    .where(
                      and(
                        eq(entities.workspaceId, b.workspaceId),
                        eq(entities.id, b.entityId),
                      ),
                    );
                  await db.insert(workObligations).values(
                    [a, b].map(
                      (f) =>
                        ({
                          entityId: f.entityId,
                          workspaceId: f.workspaceId,
                          ownerUserId: f.userId,
                          status:
                            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
                          createdByUserId: f.userId,
                          createdAt: new Date("2029-01-01T00:00:00Z"),
                        }) as const satisfies typeof workObligations.$inferInsert,
                    ),
                  );
                }
                const before = await readFixture(db, b);
                if (isResumePath(path)) {
                  const resume = async (userId: SafeId<"user">) => {
                    if (path === "feature-resume") {
                      await resumeFeatureAfterGrant({
                        organizationId: a.organizationId,
                        userId,
                        featureId: "signals",
                      });
                      return;
                    }
                    if (path === "signals-resume") {
                      await resumeSignalsAfterGrant(
                        { organizationId: a.organizationId, userId },
                        { database: db },
                      );
                      return;
                    }
                    await db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: a.organizationId,
                        featureId: "signals",
                      });
                      await resumeScoutEmissionAfterGrant({
                        tx,
                        organizationId: a.organizationId,
                        userId,
                      });
                    });
                  };
                  await db.insert(member).values({
                    id: Bun.randomUUIDv7(),
                    organizationId: a.organizationId,
                    userId: b.userId,
                    role: "member",
                    createdAt: NOW,
                  });
                  await db
                    .insert(workspaceMembers)
                    .values({ workspaceId: a.workspaceId, userId: b.userId });
                  await db.insert(featureEnrolments).values({
                    organizationId: a.organizationId,
                    userId: b.userId,
                    featureId: "signals",
                  });
                  const retained = await readFixture(db, a);
                  await resume(b.userId);
                  expect(await readFixture(db, a)).toEqual(retained);
                  testState.setConfig("FEATURE_SIGNALS", false);
                  await resume(a.userId);
                  expect(await readFixture(db, a)).toEqual(retained);
                  testState.setConfig("FEATURE_SIGNALS", true);
                  await db
                    .delete(featureEnrolments)
                    .where(
                      and(
                        eq(featureEnrolments.organizationId, a.organizationId),
                        eq(featureEnrolments.userId, a.userId),
                        eq(featureEnrolments.featureId, "signals"),
                      ),
                    );
                  await resume(a.userId);
                  expect(await readFixture(db, a)).toEqual(retained);
                  await db.insert(featureEnrolments).values({
                    organizationId: a.organizationId,
                    userId: a.userId,
                    featureId: "signals",
                  });
                  const unassignedWorkspaceId = createSafeId<"workspace">();
                  const unassignedEntityId = createSafeId<"entity">();
                  const otherRequesterRunId =
                    createSafeId<"documentReviewRun">();
                  await db.insert(workspaces).values({
                    id: unassignedWorkspaceId,
                    organizationId: a.organizationId,
                    name: "Unassigned matter",
                    reference: unassignedWorkspaceId,
                  });
                  await db.insert(entities).values({
                    id: unassignedEntityId,
                    workspaceId: unassignedWorkspaceId,
                    name: "Hearing source",
                    kind: "task",
                  });
                  await db
                    .update(documentReviewRuns)
                    .set({ status: "completed", completed: 1 })
                    .where(eq(documentReviewRuns.id, a.runId));
                  const ownRun = (
                    await db
                      .select()
                      .from(documentReviewRuns)
                      .where(eq(documentReviewRuns.id, a.runId))
                      .limit(1)
                  ).at(0);
                  if (!ownRun) {
                    panic("Missing review source");
                  }
                  await db.insert(documentReviewRuns).values({
                    ...ownRun,
                    id: otherRequesterRunId,
                    requestedBy: b.userId,
                  });
                  await withOrgScopedFixture({
                    database: db,
                    workspaceId: unassignedWorkspaceId,
                    fn: async (fixtureTx) =>
                      await fixtureTx.insert(pendingScoutEmissions).values({
                        organizationId: a.organizationId,
                        workspaceId: unassignedWorkspaceId,
                        sourceKind: "infosoud-hearing",
                        sourceId: unassignedEntityId,
                        status: "awaiting_grant",
                        nextAttemptAt: NOW,
                      }),
                  });
                  await withOrgScopedFixture({
                    database: db,
                    workspaceId: a.workspaceId,
                    fn: async (fixtureTx) =>
                      await fixtureTx.insert(pendingScoutEmissions).values({
                        organizationId: a.organizationId,
                        workspaceId: a.workspaceId,
                        sourceKind: "document-review",
                        sourceId: otherRequesterRunId,
                        status: "awaiting_grant",
                        nextAttemptAt: NOW,
                      }),
                  });
                }
                switch (path) {
                  case "review":
                    await db.transaction(async (tx) => {
                      expect(
                        await emitDocumentReviewSignal({
                          tx,
                          runId: b.runId,
                          workspaceId: a.workspaceId,
                        }),
                      ).toBe("absent");
                      await maybeEmitDocumentReviewSignal({
                        tx,
                        runId: b.runId,
                        workspaceId: a.workspaceId,
                      });
                      await maybeEmitDocumentReviewSignalRecovery({
                        tx,
                        runId: b.runId,
                        workspaceId: a.workspaceId,
                      });
                    });
                    break;
                  case "hearing":
                    await db.transaction(
                      async (tx) =>
                        await emitInfoSoudHearingSignalsRecovery({
                          tx,
                          organizationId: a.organizationId,
                          workspaceId: a.workspaceId,
                          inserted: [
                            { entityId: b.entityId, hearing: HEARING },
                          ],
                          now: NOW,
                        }),
                    );
                    break;
                  case "scout-resume":
                    await db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: a.organizationId,
                        featureId: "signals",
                      });
                      await resumeScoutEmissionAfterGrant({
                        tx,
                        organizationId: a.organizationId,
                        userId: a.userId,
                      });
                    });
                    break;
                  case "scout-recovery": {
                    const job = {
                      id: "signals.scoutRecovery.organization-fixture",
                      task: RECOVER_SCOUT_EMISSION_TASK,
                      description: null,
                      schedule: { type: "interval", everyMs: 60_000 },
                      payload: null,
                      enabled: true,
                      pausedBy: null,
                      pausedUntil: null,
                      pauseReason: null,
                      nextRunAt: NOW,
                      lastRunAt: null,
                      lastSuccessAt: null,
                      lastFailureAt: null,
                      lastError: null,
                      lockedAt: NOW,
                      lockedUntil: null,
                      lockedBy: "fixture",
                      createdAt: NOW,
                      updatedAt: NOW,
                    } as const satisfies SchedulerJob;
                    await recoverScoutEmission({
                      db: asTestRaw<typeof rootDb>(db),
                      dueAt: DueSlot.of(job),
                      job,
                      payload: null,
                      runId: createSafeId<"schedulerJobRun">(),
                      scheduleContinuation: () => undefined,
                      signal: new AbortController().signal,
                      logger,
                    });
                    expect((await readFixture(db, a)).signals).toHaveLength(1);
                    break;
                  }
                  case "signals-resume":
                    await resumeSignalsAfterGrant(
                      { organizationId: a.organizationId, userId: a.userId },
                      { database: db },
                    );
                    break;
                  case "feature-resume":
                    await resumeFeatureAfterGrant({
                      organizationId: a.organizationId,
                      userId: a.userId,
                      featureId: "signals",
                    });
                    break;
                  case "background":
                    expect(
                      await findSignalsBackgroundActor({
                        tx: db,
                        organizationId: a.organizationId,
                        workspaceId: b.workspaceId,
                      }),
                    ).toBeNull();
                    expect(
                      await loadBackgroundFeatureActors({
                        tx: db,
                        featureId: "signals",
                        principals: [
                          {
                            organizationId: a.organizationId,
                            userId: a.userId,
                          },
                        ],
                      }),
                    ).toEqual(
                      new Map([[a.organizationId, new Set([a.userId])]]),
                    );
                    break;
                  case "work-attention":
                    await runWorkAttentionScout({
                      cursor: null,
                      now: NOW,
                      dependencies: {
                        db: asTestRaw<typeof rootDb>(db),
                        createScopedDb: (options) =>
                          createRootScopedDb(options, markRlsDatabase(db)),
                      },
                    });
                    expect((await readFixture(db, a)).signals).toHaveLength(1);
                    break;
                  default:
                    path satisfies never;
                }
                expect(await readFixture(db, b)).toEqual(before);
                if (isResumePath(path)) {
                  const ownReceipts = (await readFixture(db, a)).receipts;
                  expect(
                    ownReceipts.find(({ sourceId }) => sourceId === a.runId)
                      ?.status,
                  ).toBe("pending");
                  expect(
                    ownReceipts
                      .filter(({ sourceId }) => sourceId !== a.runId)
                      .map(({ status }) => status),
                  ).toEqual(["awaiting_grant", "awaiting_grant"]);
                } else if (path === "review" || path === "hearing") {
                  expect((await readFixture(db, a)).signals).toEqual([]);
                  expect((await readFixture(db, a)).receipts).toHaveLength(1);
                }
              } finally {
                await cleanup(db, b);
                await cleanup(db, a);
              }
            },
          );
        } finally {
          testState.setConfig("FEATURE_SIGNALS", previousSignals);
          testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", previousScouts);
          restore();
        }
      },
    );

    test("review finalization retains its receipt when the requester has no matter admission", async () => {
      const previous = env.FEATURE_SIGNALS;
      const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      testState.setConfig("FEATURE_SIGNALS", true);
      testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
      try {
        await withGatedTestClients(
          process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const { db } = openClient();
            const fixture = await fixtureFor(db);
            try {
              await db
                .delete(workspaceMembers)
                .where(
                  and(
                    eq(workspaceMembers.workspaceId, fixture.workspaceId),
                    eq(workspaceMembers.userId, fixture.userId),
                  ),
                );
              expect(
                await db.$count(
                  featureEnrolments,
                  eq(featureEnrolments.organizationId, fixture.organizationId),
                ),
              ).toBe(1);
              const before = await db
                .select()
                .from(documentReviewFindings)
                .where(eq(documentReviewFindings.runId, fixture.runId))
                .orderBy(documentReviewFindings.id);
              expect(before).toHaveLength(1);
              const completed = await db.transaction(
                async (tx) =>
                  await finalizeReviewRun({
                    tx,
                    ...fixture,
                    executor: "table",
                    expectedFindingCount: 1,
                  }),
              );
              expect(completed.type).toBe("completed");
              expect(
                await db.$count(
                  signals,
                  eq(signals.organizationId, fixture.organizationId),
                ),
              ).toBe(0);
              expect(
                await db
                  .select()
                  .from(pendingScoutEmissions)
                  .where(eq(pendingScoutEmissions.sourceId, fixture.runId))
                  .orderBy(pendingScoutEmissions.sourceId),
              ).toHaveLength(1);
              expect(
                await db
                  .select()
                  .from(documentReviewFindings)
                  .where(eq(documentReviewFindings.runId, fixture.runId))
                  .orderBy(documentReviewFindings.id),
              ).toEqual(before);
            } finally {
              await cleanup(db, fixture);
            }
          },
        );
      } finally {
        testState.setConfig("FEATURE_SIGNALS", previous);
        testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", previousScouts);
        restore();
      }
    });

    for (const source of ["review", "hearing"] as const) {
      test(`${source}: revocation committed at the production admission lock retains a replayable receipt`, async () => {
        const previous = env.FEATURE_SIGNALS;
        const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        testState.setConfig("FEATURE_SIGNALS", true);
        testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const atLock = Promise.withResolvers<undefined>();
              const locked = Promise.withResolvers<undefined>();
              let readSource = false;
              const reader = openClient({
                logger: {
                  logQuery: (query) => {
                    if (query.includes('from "document_review_runs"')) {
                      readSource = true;
                    }
                    if (query.includes("pg_advisory_xact_lock")) {
                      atLock.resolve(undefined);
                    }
                  },
                },
              });
              const writer = openClient();
              const fixture = await fixtureFor(writer.db);
              try {
                const revocation = writer.db.transaction(async (tx) => {
                  await lockFeatureRecoveryAdmission({
                    tx,
                    organizationId: fixture.organizationId,
                    featureId: "signals",
                  });
                  locked.resolve(undefined);
                  await withTimeout(async () => await atLock.promise, {
                    label: "producer admission lock",
                    timeoutMs: 10_000,
                  });
                  if (source === "review") {
                    expect(readSource).toBe(true);
                  }
                  await tx
                    .delete(featureEnrolments)
                    .where(
                      eq(
                        featureEnrolments.organizationId,
                        fixture.organizationId,
                      ),
                    );
                });
                await locked.promise;
                const production = reader.db.transaction(async (tx) => {
                  const ownerTx = asTestRaw<Transaction>(tx);
                  if (source === "review") {
                    return await finalizeReviewRun({
                      tx: ownerTx,
                      ...fixture,
                      executor: "table",
                      expectedFindingCount: 1,
                    });
                  }
                  await emitInfoSoudHearingSignals({
                    tx: ownerTx,
                    ...fixture,
                    inserted: [
                      { entityId: fixture.entityId, hearing: HEARING },
                    ],
                    now: NOW,
                  });
                  return undefined;
                });
                const [, finalized] = await Promise.all([
                  revocation,
                  production,
                ]);
                if (source === "review") {
                  expect(finalized).toMatchObject({
                    type: "completed",
                    committed: 1,
                    staged: 0,
                  });
                  expect(
                    (
                      await reader.db
                        .select()
                        .from(documentReviewRuns)
                        .where(eq(documentReviewRuns.id, fixture.runId))
                    ).at(0)?.status,
                  ).toBe("completed");
                }
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(0);
                const sourceId =
                  source === "review" ? fixture.runId : fixture.entityId;
                const retained = (
                  await reader.db
                    .select()
                    .from(pendingScoutEmissions)
                    .where(eq(pendingScoutEmissions.sourceId, sourceId))
                ).at(0);
                expect(retained).toBeDefined();
                await regrant(writer.db, fixture);
                await withOrgScopedFixture({
                  database: writer.db,
                  workspaceId: fixture.workspaceId,
                  fn: async (fixtureTx) =>
                    await fixtureTx
                      .update(pendingScoutEmissions)
                      .set({ nextAttemptAt: CLAIM })
                      .where(eq(pendingScoutEmissions.sourceId, sourceId)),
                });
                if (source === "review") {
                  await reader.db.transaction(
                    async (tx) =>
                      await emitDocumentReviewSignal({
                        tx: asTestRaw<Transaction>(tx),
                        workspaceId: fixture.workspaceId,
                        runId: fixture.runId,
                      }),
                  );
                }
                for (let replay = 0; replay < 2; replay += 1) {
                  // db-await-in-loop: replay the actual producer twice to verify durable deduplication.
                  await reader.db.transaction(async (tx) => {
                    if (source === "review") {
                      await maybeEmitDocumentReviewSignal({
                        tx: asTestRaw<Transaction>(tx),
                        workspaceId: fixture.workspaceId,
                        runId: fixture.runId,
                      });
                    } else {
                      await emitInfoSoudHearingSignals({
                        tx: asTestRaw<Transaction>(tx),
                        ...fixture,
                        inserted: [
                          { entityId: fixture.entityId, hearing: HEARING },
                        ],
                        now: NOW,
                      });
                    }
                  });
                }
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(1);
                expect(
                  (
                    await reader.db
                      .select()
                      .from(pendingScoutEmissions)
                      .where(eq(pendingScoutEmissions.sourceId, sourceId))
                  ).at(0)?.nextAttemptAt,
                ).toEqual(CLAIM);
              } finally {
                atLock.resolve(undefined);
                await cleanup(writer.db, fixture);
              }
            },
          );
        } finally {
          testState.setConfig("FEATURE_SIGNALS", previous);
          testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", previousScouts);
          restore();
        }
      });
    }

    test("revocation after emission commit cannot refund or reopen an accepted deadline claim", async () => {
      const previous = env.FEATURE_SIGNALS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      testState.setConfig("FEATURE_SIGNALS", true);
      try {
        await withGatedTestClients(
          process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const reader = openClient();
            const writer = openClient();
            const fixture = await fixtureFor(writer.db);
            const sourceId = createSafeId<"documentProcessingRun">();
            try {
              await writer.db.insert(documentProcessingRuns).values({
                id: sourceId,
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                entityId: fixture.entityId,
                entityVersionId: fixture.entityVersionId,
                fieldId: fixture.fileFieldId,
                sourceFileId: Bun.randomUUIDv7(),
                sourceSha256Hex: "a".repeat(64),
                kind: "ocr",
                requestSource: "upload",
                status: "succeeded",
                deadlineScoutStatus: "running",
                deadlineScoutClaimedAt: CLAIM,
                deadlineScoutAttemptCount: 1,
              });
              const sourceToken =
                (
                  await writer.db
                    .select({
                      token: timestampCasToken(
                        documentProcessingRuns.deadlineScoutClaimedAt,
                      ),
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, sourceId))
                ).at(0)?.token ??
                panic("Missing original deadline claim token");
              let commits = 0;
              let observations = 0;
              const scopedDb = asTestRaw<ScopedDb>(
                async (operation: (tx: Transaction) => Promise<unknown>) => {
                  const value = await reader.db.transaction(
                    async (tx) => await operation(asTestRaw<Transaction>(tx)),
                  );
                  commits += 1;
                  if (commits === 2) {
                    await writer.db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: fixture.organizationId,
                        featureId: "signals",
                      });
                      await tx
                        .delete(featureEnrolments)
                        .where(
                          eq(
                            featureEnrolments.organizationId,
                            fixture.organizationId,
                          ),
                        );
                    });
                  }
                  return value;
                },
              );
              const result = await runScout({
                db: scopedDb,
                ...fixture,
                scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
                observe: () => {
                  observations += 1;
                  return [proposedFor(fixture)];
                },
                settle: async (tx, admission) => {
                  if (!admission.observationAccepted) {
                    return;
                  }
                  expect(
                    await settleDocumentDeadlineScoutClaim({
                      db: tx,
                      run: {
                        id: sourceId,
                        deadlineScoutClaimedAtToken: sourceToken,
                      },
                      settlement: { status: "succeeded", errorCode: null },
                    }),
                  ).toEqual({ status: "settled" });
                },
              });
              expect(result.outcome).toBe("emitted");
              await regrant(writer.db, fixture);
              expect(
                await pauseDocumentDeadlineScoutAfterGrantLoss({
                  database: reader.db,
                  sourceRunId: sourceId,
                  from: "running",
                  claimedAtToken: sourceToken,
                }),
              ).toEqual({ status: "stale_claim" });
              expect(
                (
                  await reader.db
                    .select()
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, sourceId))
                ).at(0),
              ).toMatchObject({
                deadlineScoutStatus: "succeeded",
                deadlineScoutAttemptCount: 1,
              });
              expect(observations).toBe(1);
              expect(
                await reader.db.$count(
                  signals,
                  eq(signals.organizationId, fixture.organizationId),
                ),
              ).toBe(1);
            } finally {
              await cleanup(writer.db, fixture);
            }
          },
        );
      } finally {
        testState.setConfig("FEATURE_SIGNALS", previous);
        restore();
      }
    });

    test("membership cleanup refuses a held recovery admission lock and preserves membership", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const reader = openClient();
          const writer = openClient();
          const fixture = await fixtureFor(writer.db);
          try {
            await writer.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: fixture.organizationId,
                featureId: "signals",
              });
              const safeDb = safeDbFromScoped(
                asTestRaw<ScopedDb>(
                  async (operation: (tx: Transaction) => Promise<unknown>) =>
                    await reader.db.transaction(
                      async (attempt) =>
                        await operation(asTestRaw<Transaction>(attempt)),
                    ),
                ),
              );
              const refused = await abortableTx(
                safeDb,
                async (attempt) =>
                  await clearMemberAssignments({
                    tx: attempt,
                    scope: {
                      type: "organization",
                      organizationId: fixture.organizationId,
                    },
                    userId: fixture.userId,
                    actorUserId: fixture.userId,
                  }),
              );
              expect(Result.isError(refused)).toBe(true);
              if (Result.isError(refused)) {
                expect(refused.error).toMatchObject({
                  status: 409,
                  retryable: true,
                });
              }
              expect(
                await reader.db.$count(
                  member,
                  eq(member.organizationId, fixture.organizationId),
                ),
              ).toBe(1);
            });
          } finally {
            await cleanup(writer.db, fixture);
          }
        },
      );
    });

    for (const race of [
      "revoked",
      "success-replaced",
      "failure-replaced",
    ] as const) {
      test(`${race}: scout effect and census settlement respect the live grant and original claim`, async () => {
        const previous = env.FEATURE_SIGNALS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        testState.setConfig("FEATURE_SIGNALS", true);
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const reader = openClient();
              const writer = openClient();
              const fixture = await fixtureFor(writer.db);
              const scopedDb = asTestRaw<ScopedDb>(
                async (operation: (tx: Transaction) => Promise<unknown>) =>
                  await reader.db.transaction(
                    async (tx) => await operation(asTestRaw<Transaction>(tx)),
                  ),
              );
              try {
                const result = await runScout({
                  db: scopedDb,
                  ...fixture,
                  scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
                  observe: async () => {
                    await writer.db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: fixture.organizationId,
                        featureId: "signals",
                      });
                      if (race === "revoked") {
                        await tx
                          .delete(featureEnrolments)
                          .where(
                            eq(
                              featureEnrolments.organizationId,
                              fixture.organizationId,
                            ),
                          );
                      } else {
                        await tx
                          .update(scoutRuns)
                          .set({ startedAt: CLAIM })
                          .where(
                            and(
                              eq(
                                scoutRuns.organizationId,
                                fixture.organizationId,
                              ),
                              eq(
                                scoutRuns.scoutKey,
                                SCOUT_KEY.INFOSOUD_HEARINGS,
                              ),
                            ),
                          );
                      }
                    });
                    if (race === "failure-replaced") {
                      throw new HandlerError({
                        status: 500,
                        message: "Synthetic stale observation failure",
                      });
                    }
                    return [proposedFor(fixture)];
                  },
                });
                expect(result).toMatchObject({
                  emittedCount: 0,
                  observationAccepted: false,
                  outcome: race === "revoked" ? "paused" : "stale",
                });
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(0);
                const census = (
                  await reader.db
                    .select()
                    .from(scoutRuns)
                    .where(eq(scoutRuns.organizationId, fixture.organizationId))
                ).at(0);
                if (race !== "revoked") {
                  expect(census).toMatchObject({
                    status: "running",
                    startedAt: CLAIM,
                    error: null,
                  });
                }
              } finally {
                await cleanup(writer.db, fixture);
              }
            },
          );
        } finally {
          testState.setConfig("FEATURE_SIGNALS", previous);
          restore();
        }
      });
    }
  },
);
