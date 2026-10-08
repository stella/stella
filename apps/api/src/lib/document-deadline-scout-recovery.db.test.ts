/**
 * A run whose deadline scout is `pending` has work owed to a queue, and
 * nothing on the row says whether a job is already carrying it. What is
 * asserted here is that the sweep dispatches such a run, and that repeating
 * the sweep does not enqueue it a second time — the property the scheduler
 * depends on now that it drives this beside the document processing worker.
 * Driven against a real (PGlite) database with a stubbed queue.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, getTableColumns, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import { SCOUT_KEY } from "@stll/api-contract/signals";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { user } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  featureEnrolments,
  scoutRuns,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { enqueueDocumentDeadlineScoutJob } from "@/api/lib/document-processing-enqueue";
import type { DocumentDeadlineScoutJobData } from "@/api/lib/document-processing-enqueue";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  recoverDocumentDeadlineScoutDispatches,
  resumeDocumentDeadlineScoutsAfterGrant,
} from "@/api/lib/scouts/document-deadline-recovery";
import {
  skipDeadlineScan,
  settleDocumentDeadlineScoutClaim,
} from "@/api/lib/scouts/document-deadlines";
import { DEADLINE_SCOUT_MAX_ATTEMPTS } from "@/api/lib/scouts/document-deadlines.logic";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const added: { data: DocumentDeadlineScoutJobData; jobId: string }[] = [];
const liveJobIds = new Set<string>();

/** The real handoff over a stubbed queue, so the idempotency under test is
 *  the one production runs rather than a re-implementation. */
const scoutQueue = {
  add: async (
    _name: string,
    data: DocumentDeadlineScoutJobData,
    options: { jobId: string },
  ) => {
    added.push({ data, jobId: options.jobId });
    liveJobIds.add(options.jobId);
  },
  getJob: async (jobId: string) =>
    liveJobIds.has(jobId)
      ? {
          getState: async () => "waiting" as const,
          remove: async () => {
            liveJobIds.delete(jobId);
          },
          retry: async () => undefined,
        }
      : undefined,
};

const sweep = async () =>
  await recoverDocumentDeadlineScoutDispatches({
    database: asTestRaw<typeof rootDb>(testDb),
    enqueueDocumentDeadlineScout: async (job) =>
      await enqueueDocumentDeadlineScoutJob({ scoutQueue, job }),
  });

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  added.length = 0;
  liveJobIds.clear();
  await testDb.delete(documentProcessingRuns);
  await testDb.delete(scoutRuns);
  await testDb
    .insert(featureEnrolments)
    .values({
      organizationId: ids.orgA,
      userId: ids.userA1,
      featureId: "signals",
    })
    .onConflictDoNothing();
});

const insertPendingScoutRun = async (): Promise<
  SafeId<"documentProcessingRun">
> => {
  const runId = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7());
  await testDb.insert(documentProcessingRuns).values({
    id: runId,
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    kind: "ocr",
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    requestedBy: null,
    requestSource: "upload",
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    workspaceId: ids.wsA1,
    // A succeeded run is the only state a scout dispatch is owed from.
    status: "succeeded",
    finishedAt: new Date(),
    deadlineScoutStatus: "pending",
  });
  return runId;
};

test("dispatches a pending scout no job owns, and only once", async () => {
  const runId = await insertPendingScoutRun();

  const first = await sweep();
  const second = await sweep();

  expect(first.count).toBe(1);
  expect(second.count).toBe(1);
  // The row stays `pending` until the scout worker claims it, so the second
  // sweep selects it again and must recognise the job it already added.
  expect(added).toEqual([
    { data: { sourceRunId: runId }, jobId: added.at(0)?.jobId ?? "" },
  ]);
});

test("leaves a run whose scout is already settled alone", async () => {
  const runId = await insertPendingScoutRun();
  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutStatus: "succeeded" })
    .where(eq(documentProcessingRuns.id, runId));

  const result = await sweep();

  expect(result.count).toBe(0);
  expect(added).toEqual([]);
});

/** Older than the dispatch lease, so the sweep nominates it as expired. */
const EXPIRED_LEASE_MS = 10 * 60 * 1000;

const insertExpiredScoutClaim = async (): Promise<
  SafeId<"documentProcessingRun">
> => {
  const runId = await insertPendingScoutRun();
  await testDb
    .update(documentProcessingRuns)
    .set({
      deadlineScoutClaimedAt: new Date(Date.now() - EXPIRED_LEASE_MS),
      deadlineScoutStatus: "running",
    })
    .where(eq(documentProcessingRuns.id, runId));
  return runId;
};

const readDeadlineClaim = async (runId: SafeId<"documentProcessingRun">) => {
  const row =
    (
      await testDb
        .select({
          ...getTableColumns(documentProcessingRuns),
          deadlineScoutClaimedAtToken: timestampCasToken(
            documentProcessingRuns.deadlineScoutClaimedAt,
          ),
        })
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0) ?? panic("Missing deadline fixture");
  const token =
    row.deadlineScoutClaimedAtToken ?? panic("Missing deadline fixture claim");
  return { ...row, deadlineScoutClaimedAtToken: token };
};

/**
 * A database handle that runs `claim` once, immediately before the first
 * UPDATE the sweep issues: the window between selecting an expired dispatch
 * and resetting it, in which the other sweep's reset can let a worker take a
 * fresh claim on the same row.
 */
const databaseClaimingBeforeFirstUpdate = (claim: () => Promise<void>) => {
  let armed = true;
  return asTestRaw<typeof rootDb>({
    select: testDb.select.bind(testDb),
    transaction: async (
      operation: Parameters<typeof testDb.transaction>[0],
    ) => {
      if (armed) {
        armed = false;
        await claim();
      }
      return await testDb.transaction(operation);
    },
  });
};

test("expiry retires exact PostgreSQL microsecond claims and dispatches the retained source", async () => {
  const runId = await insertExpiredScoutClaim();
  const scoutRunId = toSafeId<"scoutRun">(Bun.randomUUIDv7());
  const expiredAt = sql`date_trunc('milliseconds', now()) - interval '10 minutes' + interval '123 microseconds'`;
  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutClaimedAt: expiredAt })
    .where(eq(documentProcessingRuns.id, runId));
  await testDb.insert(scoutRuns).values({
    id: scoutRunId,
    organizationId: ids.orgA,
    scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
    status: "running",
    startedAt: expiredAt,
  });

  await sweep();
  expect(
    (
      await testDb
        .select({
          status: documentProcessingRuns.deadlineScoutStatus,
          claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
        })
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0),
  ).toEqual({ status: "pending", claimedAt: null });
  expect(
    (
      await testDb
        .select({ status: scoutRuns.status, error: scoutRuns.error })
        .from(scoutRuns)
        .where(eq(scoutRuns.id, scoutRunId))
    ).at(0),
  ).toEqual({ status: "failed", error: "worker_lease_expired" });
  expect(added.map(({ data }) => data)).toEqual([{ sourceRunId: runId }]);
});

test.each(["fresh", "already_expired"] as const)(
  "does not reset a replacement %s claim taken between selection and update",
  async (replacement) => {
    // The scheduler sweep and the processing worker's own reconciliation loop
    // both select this row as expired. The first resets it, a worker claims a
    // fresh attempt, and an id-only update from the second would push that live
    // claim back to `pending`: the worker's settlement predicate would then
    // reject its own result and the metered scan would replay every sweep.
    const runId = await insertExpiredScoutClaim();
    const freshClaimedAt = new Date(
      Date.now() -
        (replacement === "already_expired" ? EXPIRED_LEASE_MS - 60_000 : 0),
    );
    const database = databaseClaimingBeforeFirstUpdate(async () => {
      await testDb
        .update(documentProcessingRuns)
        .set({
          deadlineScoutClaimedAt: freshClaimedAt,
          deadlineScoutStatus: "running",
        })
        .where(eq(documentProcessingRuns.id, runId));
    });

    const result = await recoverDocumentDeadlineScoutDispatches({
      database,
      enqueueDocumentDeadlineScout: async (job) =>
        await enqueueDocumentDeadlineScoutJob({ scoutQueue, job }),
    });

    const [row] = await testDb
      .select({
        claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
        status: documentProcessingRuns.deadlineScoutStatus,
      })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId));
    expect(row?.status).toBe("running");
    expect(row?.claimedAt?.getTime()).toBe(freshClaimedAt.getTime());
    // Nothing transitioned, so the sweep reports no effect rather than counting
    // a row it did not move.
    expect(result.count).toBe(0);
    expect(added).toEqual([]);
  },
);

test("census expiry cannot retire a replacement whose start also predates the cutoff", async () => {
  const scoutRunId = toSafeId<"scoutRun">(Bun.randomUUIDv7());
  const replacementStartedAt = new Date(Date.now() - EXPIRED_LEASE_MS + 60_000);
  await testDb.insert(scoutRuns).values({
    id: scoutRunId,
    organizationId: ids.orgA,
    scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
    status: "running",
    startedAt: new Date(Date.now() - EXPIRED_LEASE_MS),
  });
  const database = databaseClaimingBeforeFirstUpdate(async () => {
    await testDb
      .update(scoutRuns)
      .set({ startedAt: replacementStartedAt })
      .where(eq(scoutRuns.id, scoutRunId));
  });
  const result = await recoverDocumentDeadlineScoutDispatches({
    database,
    enqueueDocumentDeadlineScout: async () => undefined,
  });
  expect(result.count).toBe(0);
  expect(
    (
      await testDb
        .select({ status: scoutRuns.status, startedAt: scoutRuns.startedAt })
        .from(scoutRuns)
        .where(eq(scoutRuns.id, scoutRunId))
    ).at(0),
  ).toEqual({ status: "running", startedAt: replacementStartedAt });
});

test.each([
  { status: "pending", errorCode: "observation_failed" },
  { status: "failed", errorCode: "observation_failed" },
  { status: "succeeded", errorCode: null },
  { status: "cancelled", errorCode: "source_superseded" },
  { status: "skipped", skippedUntil: new Date("2099-01-01T00:00:00Z") },
] as const)(
  "a stale %j settlement cannot mutate or refund its replacement",
  async (settlement) => {
    const runId = await insertPendingScoutRun();
    const originalClaimedAt = new Date(Date.now() - 60_000);
    const replacementClaimedAt = new Date();
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutStatus: "running",
        deadlineScoutClaimedAt: originalClaimedAt,
      })
      .where(eq(documentProcessingRuns.id, runId));
    const originalClaim = await readDeadlineClaim(runId);
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutStatus: "running",
        deadlineScoutClaimedAt: replacementClaimedAt,
        deadlineScoutAttemptCount: 3,
      })
      .where(eq(documentProcessingRuns.id, runId));
    const outcome = await settleDocumentDeadlineScoutClaim({
      db: asTestRaw<typeof rootDb>(testDb),
      run: originalClaim,
      settlement,
    });
    expect(outcome).toEqual({ status: "stale_claim" });
    expect(
      (
        await testDb
          .select({
            status: documentProcessingRuns.deadlineScoutStatus,
            claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
            attempts: documentProcessingRuns.deadlineScoutAttemptCount,
            errorCode: documentProcessingRuns.deadlineScoutErrorCode,
            skippedUntil: documentProcessingRuns.deadlineScoutSkippedUntil,
          })
          .from(documentProcessingRuns)
          .where(eq(documentProcessingRuns.id, runId))
      ).at(0),
    ).toEqual({
      status: "running",
      claimedAt: replacementClaimedAt,
      attempts: 3,
      errorCode: null,
      skippedUntil: null,
    });
  },
);

test.each(["revoked", "grant_won", "deployment_disabled"] as const)(
  "stale admission refusal with %s cannot park or refund its replacement",
  async (admission) => {
    const previousFlag = env.FEATURE_SIGNALS;
    const runId = await insertPendingScoutRun();
    const originalClaimedAt = new Date(Date.now() - 60_000);
    const replacementClaimedAt = new Date();
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutStatus: "running",
        deadlineScoutClaimedAt: originalClaimedAt,
      })
      .where(eq(documentProcessingRuns.id, runId));
    const originalClaim = await readDeadlineClaim(runId);
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutStatus: "running",
        deadlineScoutClaimedAt: replacementClaimedAt,
        deadlineScoutAttemptCount: 3,
      })
      .where(eq(documentProcessingRuns.id, runId));
    if (admission === "revoked") {
      await testDb
        .delete(featureEnrolments)
        .where(eq(featureEnrolments.userId, ids.userA1));
    }
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_SIGNALS = admission !== "deployment_disabled";
    try {
      expect(
        await skipDeadlineScan({
          db: asTestRaw<typeof rootDb>(testDb),
          runId,
          claimedAtToken: originalClaim.deadlineScoutClaimedAtToken,
          reason: "feature_not_granted",
        }),
      ).toEqual({ status: "stale_claim" });
      expect(
        (
          await testDb
            .select({
              status: documentProcessingRuns.deadlineScoutStatus,
              claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
              attempts: documentProcessingRuns.deadlineScoutAttemptCount,
            })
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, runId))
        ).at(0),
      ).toEqual({
        status: "running",
        claimedAt: replacementClaimedAt,
        attempts: 3,
      });
    } finally {
      env.FEATURE_SIGNALS = previousFlag;
      restore();
    }
  },
);

test("repeated feature refusals preserve prior failures and refund each claim exactly once", async () => {
  const runId = await insertPendingScoutRun();
  const priorFailures = 2;
  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutAttemptCount: priorFailures })
    .where(eq(documentProcessingRuns.id, runId));

  for (let cycle = 0; cycle <= DEADLINE_SCOUT_MAX_ATTEMPTS; cycle += 1) {
    const claimedAt = new Date(Date.now() + cycle);
    // db-await-in-loop: opt out before every scan refusal and restore the grant below.
    await testDb
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.userId, ids.userA1));
    // db-await-in-loop: exercise persisted claim/refusal cycles beyond the retry ceiling.
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutAttemptCount: sql`${documentProcessingRuns.deadlineScoutAttemptCount} + 1`,
        deadlineScoutClaimedAt: claimedAt,
        deadlineScoutStatus: "running",
        deadlineScoutErrorCode: null,
      })
      .where(eq(documentProcessingRuns.id, runId));
    // db-await-in-loop: retain the exact persisted token before replaying this claim.
    const claim = await readDeadlineClaim(runId);
    for (let delivery = 0; delivery < 2; delivery += 1) {
      // db-await-in-loop: replay the same refusal to verify the running-state CAS prevents double refunds.
      await skipDeadlineScan({
        db: asTestRaw<typeof rootDb>(testDb),
        runId,
        claimedAtToken: claim.deadlineScoutClaimedAtToken,
        reason: "feature_not_granted",
      });
    }
    // db-await-in-loop: verify every refusal leaves the existing failure budget unchanged.
    const paused = (
      await testDb
        .select({
          attemptCount: documentProcessingRuns.deadlineScoutAttemptCount,
          claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
          errorCode: documentProcessingRuns.deadlineScoutErrorCode,
          skippedUntil: documentProcessingRuns.deadlineScoutSkippedUntil,
          status: documentProcessingRuns.deadlineScoutStatus,
        })
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0);
    expect(paused).toEqual({
      attemptCount: priorFailures,
      claimedAt: null,
      errorCode: "feature_not_granted",
      skippedUntil: null,
      status: "awaiting_grant",
    });
    // db-await-in-loop: the actual grant transaction resumes the parked source without using an attempt.
    const grantOrganizationId = ids.orgA;
    const grantUserId = ids.userA1;
    await testDb.transaction(async (tx) => {
      await lockFeatureRecoveryAdmission({
        tx,
        organizationId: grantOrganizationId,
        featureId: "signals",
      });
      await tx.insert(featureEnrolments).values({
        organizationId: grantOrganizationId,
        userId: grantUserId,
        featureId: "signals",
      });
      await resumeDocumentDeadlineScoutsAfterGrant({
        tx: asTestRaw<
          Parameters<typeof resumeDocumentDeadlineScoutsAfterGrant>[0]["tx"]
        >(tx),
        organizationId: grantOrganizationId,
        userId: grantUserId,
      });
    });
  }
});

test("a scan skipped for an exhausted period is not dispatched before the period ends, then once", async () => {
  const runId = await insertPendingScoutRun();
  const claimedAt = new Date();
  await testDb
    .update(documentProcessingRuns)
    .set({
      deadlineScoutAttemptCount: 1,
      deadlineScoutClaimedAt: claimedAt,
      deadlineScoutStatus: "running",
    })
    .where(eq(documentProcessingRuns.id, runId));
  const periodEnd = new Date(claimedAt.getTime() + 60 * 60 * 1000);
  const claim = await readDeadlineClaim(runId);

  await skipDeadlineScan({
    db: asTestRaw<typeof rootDb>(testDb),
    runId,
    claimedAtToken: claim.deadlineScoutClaimedAtToken,
    reason: "period_exhausted",
    skippedUntil: periodEnd,
  });

  const [skipped] = await testDb
    .select({
      attemptCount: documentProcessingRuns.deadlineScoutAttemptCount,
      claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
      errorCode: documentProcessingRuns.deadlineScoutErrorCode,
      skippedUntil: documentProcessingRuns.deadlineScoutSkippedUntil,
      status: documentProcessingRuns.deadlineScoutStatus,
    })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.id, runId));
  expect(skipped).toEqual({
    // The refused claim gives its attempt back.
    attemptCount: 0,
    claimedAt: null,
    errorCode: ACTION_ADMISSION_CODES.periodExhausted,
    skippedUntil: periodEnd,
    status: "pending",
  });

  // Repeated sweeps inside the period enqueue nothing: no retry loop.
  expect((await sweep()).count).toBe(0);
  expect((await sweep()).count).toBe(0);
  expect(added).toEqual([]);

  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutSkippedUntil: new Date(Date.now() - 1) })
    .where(eq(documentProcessingRuns.id, runId));
  expect((await sweep()).count).toBe(1);
  expect(added.map(({ data }) => data)).toEqual([{ sourceRunId: runId }]);
});

test("a skip applies only to a running scan, and only a pending scan may carry one", async () => {
  const runId = await insertExpiredScoutClaim();
  const claim = await readDeadlineClaim(runId);
  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutStatus: "pending", deadlineScoutClaimedAt: null })
    .where(eq(documentProcessingRuns.id, runId));
  await skipDeadlineScan({
    db: asTestRaw<typeof rootDb>(testDb),
    runId,
    claimedAtToken: claim.deadlineScoutClaimedAtToken,
    reason: "period_exhausted",
    skippedUntil: new Date(Date.now() + 60_000),
  });
  const [untouched] = await testDb
    .select({ skippedUntil: documentProcessingRuns.deadlineScoutSkippedUntil })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.id, runId));
  expect(untouched?.skippedUntil).toBeNull();

  const writeSkipWithStatus = async (
    deadlineScoutStatus: "running" | "succeeded" | "not_requested",
  ) =>
    await Result.tryPromise(
      async () =>
        await testDb
          .update(documentProcessingRuns)
          .set({
            deadlineScoutClaimedAt:
              deadlineScoutStatus === "running" ? new Date() : null,
            deadlineScoutErrorCode: null,
            deadlineScoutSkippedUntil: new Date(),
            deadlineScoutStatus,
          })
          .where(eq(documentProcessingRuns.id, runId)),
    );
  const writes = [
    await writeSkipWithStatus("running"),
    await writeSkipWithStatus("succeeded"),
    await writeSkipWithStatus("not_requested"),
  ];
  expect(writes.map((write) => Result.isError(write))).toEqual([
    true,
    true,
    true,
  ]);
});
