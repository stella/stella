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

import { member, organization, user } from "@/api/db/auth-schema";
import { flowDefinitions, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { flowScheduleToSchedulerSchedule } from "@/api/lib/flows/flow-trigger-logic";
import type { FlowTrigger } from "@/api/lib/flows/flow-types";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerDb, SchedulerJob } from "@/api/lib/scheduler/types";
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
  const task = createScheduledFlowTask(async (input) => {
    started.push(input.definitionId);
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
      email: `${authorId}@test.local`,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: authorId,
      role: "member",
      createdAt: new Date(),
    });
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
    const job: SchedulerJob = {
      id: flowScheduleJobId(definitionId),
      task: FLOW_RUN_TASK,
      description: null,
      schedule: flowScheduleToSchedulerSchedule(schedule),
      payload: { definitionId },
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
    setSystemTime(wallClock);
    await task({
      db: asTestRaw<SchedulerDb>(testDb),
      dueAt: DueSlot.of(job),
      job,
      logger,
      payload: job.payload,
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: () => undefined,
      signal: new AbortController().signal,
    });
  };

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
