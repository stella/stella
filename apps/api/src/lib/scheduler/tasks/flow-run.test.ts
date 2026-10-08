/**
 * A scheduled flow's weekly / monthly day is the day of the slot the job was
 * due for, whatever the wall clock says when the runner gets to it. Driven
 * against a real (PGlite) database so the task's definition and workspace
 * checks run as in production; only the run starter is recorded.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  flowDefinitions,
  schedulerJobs,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { flowScheduleToSchedulerSchedule } from "@/api/lib/flows/flow-trigger-logic";
import type {
  FlowTrigger,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import type { StartAutomatedFlowRunOutcome } from "@/api/lib/flows/start-automated-flow-run";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerDb, SchedulerJob } from "@/api/lib/scheduler/types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  createScheduledFlowTask,
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "./flow-run";

const testDb: TestDatabase = await getTestDb();

// 2026-07-06 is a Monday, 2026-07-05 a Sunday.
const MONDAY_SLOT = new Date("2026-07-06T23:00:00.000Z");
const SUNDAY_SLOT = new Date("2026-07-05T23:00:00.000Z");
const TUESDAY_AFTER_MIDNIGHT = new Date("2026-07-07T00:10:00.000Z");
const MONDAY_AFTER_MIDNIGHT = new Date("2026-07-06T00:10:00.000Z");

type Schedule = Extract<FlowTrigger, { type: "schedule" }>["schedule"];

describe("scheduled flow due day", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const authorId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const started: string[] = [];
  const startedSources = new Map<string, FlowTriggerSource>();
  const startOutcomes = new Map<string, StartAutomatedFlowRunOutcome>();
  const task = createScheduledFlowTask(async (input) => {
    started.push(input.definitionId);
    startedSources.set(input.definitionId, input.triggerSource);
    return startOutcomes.get(input.definitionId) ?? { status: "settled" };
  });

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Scheduled Flow Org",
      slug: `scheduled-flow-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: authorId,
      name: "Flow Author",
      emailVerified: true,
      email: `${authorId}@example.test`,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: authorId,
      role: "member",
      createdAt: new Date(),
    });
    await testDb
      .insert(featureEnrolments)
      .values({ featureId: "flows", organizationId, userId: authorId });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      clientId: null,
      name: "Scheduled matter",
      reference: "SCHED-1",
    });
  });

  afterEach(() => {
    setSystemTime();
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const createDefinition = async (
    schedule: Schedule,
  ): Promise<SafeId<"flowDefinition">> => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: `Scheduled ${schedule.frequency} flow`,
      steps: [
        {
          kind: "ai",
          name: "Draft memo",
          prompt: "Draft a short legal memo.",
          includeDocuments: false,
        },
      ],
      trigger: { type: "schedule", workspaceId, schedule },
      enabled: true,
      createdByUserId: authorId,
    });
    return definitionId;
  };

  /** One claimed tick of the definition's job, due at `nextRunAt`. */
  const runTick = async (
    definitionId: SafeId<"flowDefinition">,
    schedule: Schedule,
    nextRunAt: Date,
    wallClock: Date,
  ) => {
    const persisted = await testDb.query.schedulerJobs.findFirst({
      where: { id: { eq: flowScheduleJobId(definitionId) } },
    });
    const job: SchedulerJob = {
      id: flowScheduleJobId(definitionId),
      task: FLOW_RUN_TASK,
      description: null,
      schedule: flowScheduleToSchedulerSchedule(schedule),
      payload: persisted?.payload ?? { definitionId },
      enabled: true,
      pausedBy: null,
      pausedUntil: null,
      pauseReason: null,
      nextRunAt,
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lockedAt: wallClock,
      lockedUntil: null,
      lockedBy: "test-lease",
      createdAt: nextRunAt,
      updatedAt: nextRunAt,
    };
    await testDb
      .insert(schedulerJobs)
      .values(job)
      .onConflictDoUpdate({
        target: schedulerJobs.id,
        set: { nextRunAt, lockedAt: wallClock, lockedBy: "test-lease" },
      });
    let continuationAt: Date | null = null;
    setSystemTime(wallClock);
    await task({
      db: asTestRaw<SchedulerDb>(testDb),
      dueAt: DueSlot.of(job),
      job,
      logger,
      payload: job.payload,
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: (next) => {
        continuationAt = next;
      },
      signal: new AbortController().signal,
    });
    return {
      continuationAt,
      payload: (
        await testDb.query.schedulerJobs.findFirst({
          where: { id: { eq: job.id } },
        })
      )?.payload,
    };
  };

  test("deployment disabled retains a validated daily slot without starting", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = false;
    try {
      const schedule: Schedule = { frequency: "daily", hourUtc: 23 };
      const definitionId = await createDefinition(schedule);
      await runTick(definitionId, schedule, MONDAY_SLOT, MONDAY_SLOT);
      expect(started.filter((id) => id === definitionId)).toHaveLength(0);
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });

  for (const frequency of ["weekly", "monthly"] as const) {
    for (const status of ["paused", "retry"] as const) {
      test(`${frequency} starter ${status} preserves the validated slot through a non-due retry`, async () => {
        const schedule: Schedule =
          frequency === "weekly"
            ? { frequency, hourUtc: 23, dayOfWeek: 1 }
            : { frequency, hourUtc: 23, dayOfMonth: 6 };
        const definitionId = await createDefinition(schedule);
        startOutcomes.set(definitionId, { status });
        const held = await runTick(
          definitionId,
          schedule,
          MONDAY_SLOT,
          TUESDAY_AFTER_MIDNIGHT,
        );
        expect(held.payload).toEqual({
          definitionId,
          pendingDueAt: MONDAY_SLOT.toISOString(),
          pendingClaimedAt: TUESDAY_AFTER_MIDNIGHT.toISOString(),
        });
        expect(held.continuationAt).toEqual(
          new Date(TUESDAY_AFTER_MIDNIGHT.getTime() + 5 * 60 * 1000),
        );
        startOutcomes.delete(definitionId);
        const retry = new Date("2026-07-08T00:10:00.000Z");
        const settled = await runTick(definitionId, schedule, retry, retry);
        expect(startedSources.get(definitionId)).toEqual({
          type: "schedule",
          dueSlot: MONDAY_SLOT.toISOString(),
        });
        expect(settled.payload).toEqual({ definitionId });
      });
    }
    for (const refusal of [
      "deployment_disabled",
      "actor_not_granted",
    ] as const) {
      test(`${frequency} ${refusal} ignores non-due slots and settles stale retained slots before regrant`, async () => {
        const previousFlag = env.FEATURE_FLOWS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        const schedule: Schedule =
          frequency === "weekly"
            ? { frequency, hourUtc: 23, dayOfWeek: 1 }
            : { frequency, hourUtc: 23, dayOfMonth: 6 };
        const definitionId = await createDefinition(schedule);
        env.FEATURE_FLOWS = refusal !== "deployment_disabled";
        if (refusal === "actor_not_granted") {
          await testDb
            .delete(featureEnrolments)
            .where(eq(featureEnrolments.userId, authorId));
        }
        try {
          const nonDue = await runTick(
            definitionId,
            schedule,
            SUNDAY_SLOT,
            SUNDAY_SLOT,
          );
          expect(nonDue.continuationAt).toBeNull();
          expect(nonDue.payload).toEqual({ definitionId });
          await testDb
            .update(schedulerJobs)
            .set({
              payload: {
                definitionId,
                pendingDueAt: SUNDAY_SLOT.toISOString(),
              },
            })
            .where(eq(schedulerJobs.id, flowScheduleJobId(definitionId)));
          const staleNonDue = await runTick(
            definitionId,
            schedule,
            SUNDAY_SLOT,
            SUNDAY_SLOT,
          );
          expect(staleNonDue.continuationAt).toBeNull();
          expect(staleNonDue.payload).toEqual({ definitionId });
          // Older persisted receipts can also survive until the next due day without a prior cleanup tick.
          await testDb
            .update(schedulerJobs)
            .set({
              payload: {
                definitionId,
                pendingDueAt: SUNDAY_SLOT.toISOString(),
              },
            })
            .where(eq(schedulerJobs.id, flowScheduleJobId(definitionId)));
          env.FEATURE_FLOWS = true;
          if (refusal === "actor_not_granted") {
            await testDb
              .insert(featureEnrolments)
              .values({ featureId: "flows", organizationId, userId: authorId });
          }
          const resumed = await runTick(
            definitionId,
            schedule,
            MONDAY_SLOT,
            MONDAY_SLOT,
          );
          expect(resumed.continuationAt).toBeNull();
          expect(resumed.payload).toEqual({ definitionId });
          expect(started.filter((id) => id === definitionId)).toHaveLength(1);
          expect(startedSources.get(definitionId)).toEqual({
            type: "schedule",
            dueSlot: MONDAY_SLOT.toISOString(),
          });
        } finally {
          env.FEATURE_FLOWS = previousFlag;
          restore();
          await testDb
            .insert(featureEnrolments)
            .values({ featureId: "flows", organizationId, userId: authorId })
            .onConflictDoNothing();
        }
      });
    }
  }

  test("a validated collapsed backlog retains its original coverage across opt-out and regrant", async () => {
    const schedule: Schedule = {
      frequency: "weekly",
      hourUtc: 9,
      dayOfWeek: 1,
    };
    const definitionId = await createDefinition(schedule);
    const sundayDue = new Date("2026-07-05T09:00:00.000Z");
    const mondayClaim = new Date("2026-07-06T10:00:00.000Z");
    await testDb
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.userId, authorId));
    try {
      const paused = await runTick(
        definitionId,
        schedule,
        sundayDue,
        mondayClaim,
      );
      expect(paused.payload).toEqual({
        definitionId,
        pendingDueAt: sundayDue.toISOString(),
        pendingClaimedAt: mondayClaim.toISOString(),
      });
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId: authorId });
      const laterClaim = new Date("2026-07-07T10:00:00.000Z");
      const resumed = await runTick(
        definitionId,
        schedule,
        laterClaim,
        laterClaim,
      );
      expect(started.filter((id) => id === definitionId)).toHaveLength(1);
      expect(startedSources.get(definitionId)).toEqual({
        type: "schedule",
        dueSlot: sundayDue.toISOString(),
      });
      expect(resumed.payload).toEqual({ definitionId });
    } finally {
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId: authorId })
        .onConflictDoNothing();
    }
  });

  test("ungranted definition author skips the no-caller scheduled start", async () => {
    await testDb
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.userId, authorId));
    try {
      const schedule: Schedule = { frequency: "daily", hourUtc: 23 };
      const definitionId = await createDefinition(schedule);
      await runTick(definitionId, schedule, MONDAY_SLOT, MONDAY_SLOT);
      expect(started.filter((id) => id === definitionId)).toHaveLength(0);
    } finally {
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId: authorId });
    }
  });

  test("a paused weekly slot survives opt-out and resumes on its original due day", async () => {
    const schedule: Schedule = {
      frequency: "weekly",
      hourUtc: 23,
      dayOfWeek: 1,
    };
    const definitionId = await createDefinition(schedule);
    await testDb
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.userId, authorId));
    try {
      const paused = await runTick(
        definitionId,
        schedule,
        MONDAY_SLOT,
        TUESDAY_AFTER_MIDNIGHT,
      );
      expect(paused.continuationAt).toEqual(
        new Date(TUESDAY_AFTER_MIDNIGHT.getTime() + 5 * 60 * 1000),
      );
      expect(paused.payload?.["pendingDueAt"]).toBe(MONDAY_SLOT.toISOString());
      expect(started.filter((id) => id === definitionId)).toHaveLength(0);
    } finally {
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId: authorId });
    }
    const retryAt = new Date(TUESDAY_AFTER_MIDNIGHT.getTime() + 5 * 60 * 1000);
    const resumed = await runTick(definitionId, schedule, retryAt, retryAt);
    expect(started.filter((id) => id === definitionId)).toHaveLength(1);
    expect(startedSources.get(definitionId)).toEqual({
      type: "schedule",
      dueSlot: MONDAY_SLOT.toISOString(),
    });
    expect(resumed.payload).toEqual({ definitionId });
  });

  test("a Monday slot claimed after midnight still starts Monday's weekly run", async () => {
    const schedule: Schedule = {
      frequency: "weekly",
      hourUtc: 23,
      dayOfWeek: 1,
    };
    const definitionId = await createDefinition(schedule);

    await runTick(definitionId, schedule, MONDAY_SLOT, TUESDAY_AFTER_MIDNIGHT);

    expect(started.filter((id) => id === definitionId)).toHaveLength(1);
  });

  test("a Sunday slot claimed on Monday does not start Monday's weekly run", async () => {
    const schedule: Schedule = {
      frequency: "weekly",
      hourUtc: 23,
      dayOfWeek: 1,
    };
    const definitionId = await createDefinition(schedule);

    await runTick(definitionId, schedule, SUNDAY_SLOT, MONDAY_AFTER_MIDNIGHT);
    expect(started.filter((id) => id === definitionId)).toHaveLength(0);

    // The Monday slot is the one that runs, exactly once.
    await runTick(definitionId, schedule, MONDAY_SLOT, MONDAY_SLOT);
    expect(started.filter((id) => id === definitionId)).toHaveLength(1);
  });

  test("a Sunday slot claimed after Monday's slot elapsed starts Monday's weekly run", async () => {
    const schedule: Schedule = {
      frequency: "weekly",
      hourUtc: 9,
      dayOfWeek: 1,
    };
    const definitionId = await createDefinition(schedule);

    // The runner collapses the backlog and schedules Tuesday 09:00 next, so
    // this claim is the only one that can start Monday's run.
    await runTick(
      definitionId,
      schedule,
      new Date("2026-07-05T09:00:00.000Z"),
      new Date("2026-07-06T10:00:00.000Z"),
    );
    expect(started.filter((id) => id === definitionId)).toHaveLength(1);
  });

  test("a month-end slot claimed on the 1st still starts the month-end run", async () => {
    const schedule: Schedule = {
      frequency: "monthly",
      hourUtc: 23,
      dayOfMonth: 31,
    };
    const definitionId = await createDefinition(schedule);

    await runTick(
      definitionId,
      schedule,
      new Date("2026-07-31T23:00:00.000Z"),
      new Date("2026-08-01T00:20:00.000Z"),
    );
    expect(started.filter((id) => id === definitionId)).toHaveLength(1);

    // The slot of the 1st, claimed late on the 2nd, is not the 31st's run.
    await runTick(
      definitionId,
      schedule,
      new Date("2026-08-01T23:00:00.000Z"),
      new Date("2026-08-02T00:20:00.000Z"),
    );
    expect(started.filter((id) => id === definitionId)).toHaveLength(1);
  });
});
