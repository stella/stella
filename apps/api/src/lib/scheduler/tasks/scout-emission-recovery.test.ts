import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
  featureEnrolments,
  pendingScoutEmissions,
  signals,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  RECOVER_SCOUT_EMISSION_TASK,
  recoverScoutEmission,
} from "@/api/lib/scheduler/tasks/scout-emission-recovery";
import type { SchedulerJob } from "@/api/lib/scheduler/types";
import { maybeEmitDocumentReviewSignal } from "@/api/lib/scouts/document-review";
import { emitInfoSoudHearingSignals } from "@/api/lib/scouts/infosoud-hearings";
import type { HearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const initialTime = new Date("2030-01-01T12:00:00.000Z");
const scoped = createRootScopedDb(
  { organizationId, userId, workspaceIds: [workspaceId] },
  asTestRaw<RlsDatabase<Transaction>>(db),
);
const previousSignalsFlag = env.FEATURE_SIGNALS;
const previousScoutFlag = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });

beforeAll(async () => {
  env.FEATURE_SIGNALS = true;
  env.FEATURE_INBOX_DOCUMENT_SCOUTS = true;
  await db.insert(organization).values({
    id: organizationId,
    name: "Scout recovery",
    slug: `scout-${organizationId}`,
    createdAt: initialTime,
  });
  await db.insert(user).values({
    id: userId,
    name: "Scout recipient",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: initialTime,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Scout matter",
    reference: "SCOUT",
  });
  await db
    .insert(workspaceMembers)
    .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
});

beforeEach(async () => {
  await db
    .delete(pendingScoutEmissions)
    .where(eq(pendingScoutEmissions.organizationId, organizationId));
  await db.delete(signals).where(eq(signals.organizationId, organizationId));
  await db
    .delete(featureEnrolments)
    .where(eq(featureEnrolments.organizationId, organizationId));
});

afterAll(async () => {
  env.FEATURE_SIGNALS = previousSignalsFlag;
  env.FEATURE_INBOX_DOCUMENT_SCOUTS = previousScoutFlag;
  restoreMode();
  await releaseTestDb();
});

const enrol = async () =>
  await db
    .insert(featureEnrolments)
    .values({ organizationId, userId, featureId: "signals" });
const pending = async () =>
  await db
    .select()
    .from(pendingScoutEmissions)
    .where(eq(pendingScoutEmissions.organizationId, organizationId));
const emitted = async () =>
  await db
    .select({ kind: signals.kind })
    .from(signals)
    .where(eq(signals.organizationId, organizationId));

const runRecovery = async (now = initialTime) => {
  const job = {
    id: "signals.scoutRecovery.test",
    task: RECOVER_SCOUT_EMISSION_TASK,
    description: null,
    schedule: { type: "interval", everyMs: 60_000 },
    payload: null,
    enabled: true,
    pausedBy: null,
    pausedUntil: null,
    pauseReason: null,
    nextRunAt: now,
    lastRunAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lockedAt: now,
    lockedUntil: null,
    lockedBy: "recovery-test",
    createdAt: now,
    updatedAt: now,
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
};

const seedReview = async () => {
  const entityId = createSafeId<"entity">();
  const runId = createSafeId<"documentReviewRun">();
  const fileFieldId = createSafeId<"field">();
  const entityVersionId = createSafeId<"entityVersion">();
  const positionId = Bun.randomUUIDv7();
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Recovery document",
    createdBy: userId,
  });
  await db.insert(documentReviewRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId,
    fileFieldId,
    entityVersionId,
    contentSha256: "a".repeat(64),
    requestedBy: userId,
    status: "completed",
    total: 1,
    completed: 1,
    basis: {
      playbook: {
        definitionId: null,
        versionId: null,
        provenance: "ephemeral",
        definitionSnapshot: { name: "Recovery playbook", positions: {} },
      },
      references: [],
      perspective: { type: "neutral" },
    },
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
    positionTitle: "Governing law",
    outcome: "deviation",
    payload: {
      finding: {
        positionId,
        issue: "Governing law",
        severity: "medium",
        standardSource: "tiers",
        verdict: "deviation",
        delta: { kind: "language" },
        extracted: null,
        rationale: "Differs from the playbook",
        citations: [],
        fix: null,
      },
    },
  });
  await scoped(
    async (tx) =>
      await maybeEmitDocumentReviewSignal({ tx, workspaceId, runId }),
  );
  return runId;
};

const seedHearing = async () => {
  const entityId = createSafeId<"entity">();
  const hearing = {
    externalId: `hearing-${entityId}`,
    caseMark: "Test case",
    court: "Test court",
    hearingType: "hearing",
    startAt: new Date("2030-01-10T10:00:00.000Z"),
    cancelled: false,
    date: "2030-01-10",
    time: "11:00",
  } satisfies HearingRecord;
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "task",
    name: "Recovery hearing",
    createdBy: userId,
    externalSource: "infosoud",
    externalId: hearing.externalId,
    startAt: hearing.startAt,
    externalData: {
      hearing: {
        type: hearing.hearingType,
        cancelled: hearing.cancelled,
        date: hearing.date,
        time: hearing.time,
      },
      case: { caseMark: hearing.caseMark, court: hearing.court },
    },
  });
  await scoped(
    async (tx) =>
      await emitInfoSoudHearingSignals({
        tx,
        organizationId,
        workspaceId,
        inserted: [{ entityId, hearing }],
        now: initialTime,
      }),
  );
  return entityId;
};

describe("deferred scout emission recovery", () => {
  for (const sourceKind of ["document-review", "infosoud-hearing"] as const) {
    test(`${sourceKind}: opt-out retains intent, regrant emits once across concurrent delivery`, async () => {
      await enrol();
      await db
        .delete(featureEnrolments)
        .where(eq(featureEnrolments.organizationId, organizationId));
      const sourceId =
        sourceKind === "document-review"
          ? await seedReview()
          : await seedHearing();
      expect(await emitted()).toEqual([]);
      expect((await pending()).map((row) => row.sourceId)).toEqual([sourceId]);
      await runRecovery();
      expect(await pending()).toHaveLength(1);
      expect(await emitted()).toEqual([]);
      await enrol();
      const retryTime = new Date(initialTime.getTime() + 5 * 60 * 1000);
      await Promise.all([runRecovery(retryTime), runRecovery(retryTime)]);
      expect(await pending()).toEqual([]);
      expect(await emitted()).toEqual([
        {
          kind:
            sourceKind === "document-review"
              ? "contract.reviewed"
              : "hearing.changed",
        },
      ]);
      await runRecovery(retryTime);
      expect(await emitted()).toHaveLength(1);
    });
  }

  test("deployment disabled retains both source intents until re-enabled", async () => {
    await seedReview();
    await seedHearing();
    await enrol();
    env.FEATURE_SIGNALS = false;
    try {
      await runRecovery();
      expect(await pending()).toHaveLength(2);
      expect(await emitted()).toEqual([]);
    } finally {
      env.FEATURE_SIGNALS = true;
    }
    await runRecovery();
    expect(await pending()).toEqual([]);
    expect(await emitted()).toHaveLength(2);
  });

  test("failed settlement rolls back its emitted signal, records retry and continues with another source", async () => {
    const reviewId = await seedReview();
    await seedHearing();
    await enrol();
    await db.execute(sql`CREATE FUNCTION scout_recovery_test_fail_review() RETURNS trigger AS $$
      BEGIN IF OLD.source_kind = 'document-review' THEN RAISE EXCEPTION 'scout_emission_test_failure'; END IF; RETURN OLD; END;
    $$ LANGUAGE plpgsql`);
    await db.execute(
      sql`CREATE TRIGGER scout_recovery_test_fail_review BEFORE DELETE ON pending_scout_emissions FOR EACH ROW EXECUTE FUNCTION scout_recovery_test_fail_review()`,
    );
    try {
      await runRecovery();
      const remaining = await pending();
      expect(remaining).toHaveLength(1);
      expect(remaining.at(0)?.sourceId).toBe(reviewId);
      expect(remaining.at(0)?.lastError).toBe("DrizzleQueryError");
      expect(remaining.at(0)?.nextAttemptAt).toEqual(
        new Date(initialTime.getTime() + 5 * 60 * 1000),
      );
      expect(await emitted()).toEqual([{ kind: "hearing.changed" }]);
    } finally {
      await db.execute(
        sql`DROP TRIGGER scout_recovery_test_fail_review ON pending_scout_emissions`,
      );
      await db.execute(sql`DROP FUNCTION scout_recovery_test_fail_review()`);
    }
    await runRecovery(new Date(initialTime.getTime() + 5 * 60 * 1000));
    expect(await pending()).toEqual([]);
    expect(await emitted()).toHaveLength(2);
  });
});
