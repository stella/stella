import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { user } from "@/api/db/auth-schema";
import {
  schedulerJobRuns,
  schedulerJobs,
  systemAuditRuns,
} from "@/api/db/schema";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  changedSealTables,
  readTableDigests,
} from "@/api/lib/scheduler/seed-seal";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  AgentSchedulerStateError,
  assertAgentSchedulerPaused,
  pauseAgentScheduler,
  resumeAgentScheduler,
  sealAgentStack,
  settleAgentScheduler,
} from "./agent-stack";
import { runSchedulerOnce } from "./runner";
import { SchedulerTaskFailure } from "./types";
import type {
  SchedulerDb,
  SchedulerMaintenanceDb,
  SchedulerTaskContext,
  SchedulerTaskRegistry,
} from "./types";

const USER_ID = "agent_stack_seal_user";
const JOB_ID = "agent-stack.content-refresh";
const TASK_ID = "agent-stack.content-refresh";
const MINUTE_MS = 60_000;
const IDLE_MINUTES = 5;
const PAUSE_AUDIT_ACTOR = "system:scheduler-pauses";
let testDb: TestDatabase;
let db: SchedulerDb;
let sealDirectory: string;
let sealPath: string;

beforeAll(async () => {
  testDb = await getTestDb();
  db = asTestRaw<SchedulerDb>(testDb);
});

afterAll(async () => {
  await testDb
    .delete(systemAuditRuns)
    .where(eq(systemAuditRuns.actor, PAUSE_AUDIT_ACTOR));
  await testDb.delete(schedulerJobRuns);
  await testDb.delete(schedulerJobs);
  await testDb.delete(user).where(eq(user.id, USER_ID));
  await releaseTestDb();
});

afterEach(() => {
  rmSync(sealDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  sealDirectory = mkdtempSync(path.join(tmpdir(), "agent-stack-seal-test-"));
  sealPath = path.join(sealDirectory, "seal.json");
  await testDb
    .delete(systemAuditRuns)
    .where(eq(systemAuditRuns.actor, PAUSE_AUDIT_ACTOR));
  await testDb.delete(schedulerJobRuns);
  await testDb.delete(schedulerJobs);
  await testDb.delete(user).where(eq(user.id, USER_ID));
  await testDb.insert(user).values({
    id: USER_ID,
    name: "Seeded test user",
    email: "agent-stack@example.test",
    preferredName: "seed",
  });
  await testDb.insert(schedulerJobs).values({
    id: JOB_ID,
    description: "Refresh seeded content",
    task: TASK_ID,
    schedule: { type: "interval", everyMs: MINUTE_MS },
    nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
  });
});

const contentRegistry = new Map([
  [
    TASK_ID,
    async ({ db: taskDb }: SchedulerTaskContext) => {
      await taskDb
        .update(user)
        .set({ preferredName: sql`${user.preferredName} || ':refresh'` })
        .where(eq(user.id, USER_ID));
    },
  ],
]) satisfies SchedulerTaskRegistry;

const readSeededName = async () => {
  const [row] = await testDb
    .select({ preferredName: user.preferredName })
    .from(user)
    .where(eq(user.id, USER_ID));
  return row?.preferredName;
};

const readPauseAudits = async (database: SchedulerMaintenanceDb) =>
  await database
    .select()
    .from(systemAuditRuns)
    .where(eq(systemAuditRuns.actor, PAUSE_AUDIT_ACTOR))
    .orderBy(systemAuditRuns.id)
    .limit(20);

test("a settled sealed stack stays pristine for five idle scheduler minutes", async () => {
  await pauseAgentScheduler(db);
  expect(
    (await sealAgentStack(db, { registry: contentRegistry, sealPath })).isOk(),
  ).toBe(true);
  expect(await readSeededName()).toBe("seed:refresh");
  const sealed = await readTableDigests(db);
  expect(JSON.parse(readFileSync(sealPath, "utf-8"))).toEqual(sealed);

  const clockStart = Date.now();
  for (let minute = 1; minute <= IDLE_MINUTES; minute += 1) {
    // Eligibility advances past the recurring job without waiting in CI.
    // db-await-in-loop: exercises sequential scheduler ticks against the same sealed database
    const tick = await runSchedulerOnce({
      db,
      registry: contentRegistry,
      runnerId: "agent-stack-idle-test",
      limit: 1,
      eligibilityNow: () => clockStart + minute * MINUTE_MS,
    });
    expect(tick.acquired).toBe(0);
  }

  expect(await readSeededName()).toBe("seed:refresh");
  expect(changedSealTables(sealed, await readTableDigests(db))).toEqual([]);
});

test("lifting the scheduler pause refuses capture before seeded content drifts", async () => {
  await pauseAgentScheduler(db);
  expect(
    (await sealAgentStack(db, { registry: contentRegistry, sealPath })).isOk(),
  ).toBe(true);
  const sealed = await readTableDigests(db);
  expect(JSON.parse(readFileSync(sealPath, "utf-8"))).toEqual(sealed);
  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  await resumeAgentScheduler(db);

  expect(await readSeededName()).toBe("seed:refresh");
  expect(changedSealTables(sealed, await readTableDigests(db))).toEqual([
    "public.system_audit_runs",
  ]);
  expect(await readPauseAudits(db)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: PAUSE_AUDIT_ACTOR,
        counts: { pausedJobs: 0, resumedJobs: 1 },
      }),
    ]),
  );
  const pauseState = await assertAgentSchedulerPaused(db);
  const refusal = pauseState.isErr() ? pauseState.error : undefined;
  expect(refusal).toBeInstanceOf(AgentSchedulerStateError);
  expect(refusal).toMatchObject({
    message: expect.stringContaining(
      "run `bun run agent:reset` before agent:drive",
    ),
  });
  const resumed = await runSchedulerOnce({
    db,
    registry: contentRegistry,
    runnerId: "agent-stack-resumed-test",
    limit: 1,
    eligibilityNow: () => Date.now() + IDLE_MINUTES * MINUTE_MS,
  });
  expect(resumed.succeeded).toBe(1);
  expect(changedSealTables(sealed, await readTableDigests(db))).toEqual([
    "public.system_audit_runs",
    "public.user",
  ]);
});

test("a content write after sealing still invalidates a paused stack", async () => {
  await pauseAgentScheduler(db);
  expect(
    (await sealAgentStack(db, { registry: contentRegistry, sealPath })).isOk(),
  ).toBe(true);
  const sealed = await readTableDigests(db);
  expect(JSON.parse(readFileSync(sealPath, "utf-8"))).toEqual(sealed);
  await testDb
    .update(user)
    .set({ name: "Content entered after seeding" })
    .where(eq(user.id, USER_ID));

  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  expect(changedSealTables(sealed, await readTableDigests(db))).toEqual([
    "public.user",
  ]);
});

test("one unpaused job makes the sealed scheduler unsafe for capture", async () => {
  await testDb.insert(schedulerJobs).values({
    id: "agent-stack.second-job",
    description: "Another recurring job",
    task: TASK_ID,
    schedule: { type: "interval", everyMs: MINUTE_MS },
    nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  await pauseAgentScheduler(db);
  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  await testDb
    .update(schedulerJobs)
    .set({ pausedUntil: null, pausedBy: null, pauseReason: null })
    .where(eq(schedulerJobs.id, JOB_ID));

  const pauseState = await assertAgentSchedulerPaused(db);
  expect(pauseState.isErr() ? pauseState.error : undefined).toBeInstanceOf(
    AgentSchedulerStateError,
  );
});

test("settling executes each due job once and leaves future work alone", async () => {
  const secondDueJobId = "agent-stack.second-due-job";
  const futureJobId = "agent-stack.future-job";
  await testDb.insert(schedulerJobs).values([
    {
      id: secondDueJobId,
      description: "Another due recurring job",
      task: TASK_ID,
      schedule: { type: "interval", everyMs: MINUTE_MS },
      nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
    },
    {
      id: futureJobId,
      description: "Future recurring job",
      task: TASK_ID,
      schedule: { type: "interval", everyMs: MINUTE_MS },
      nextRunAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  ]);
  const executions: string[] = [];
  const registry = new Map([
    [
      TASK_ID,
      ({ job, scheduleContinuation }: SchedulerTaskContext) => {
        executions.push(job.id);
        scheduleContinuation(new Date("2020-01-01T00:00:00.000Z"));
      },
    ],
  ]) satisfies SchedulerTaskRegistry;

  await pauseAgentScheduler(db);
  expect((await settleAgentScheduler({ db, registry })).isOk()).toBe(true);

  expect(executions.toSorted()).toEqual([JOB_ID, secondDueJobId].toSorted());
  const jobs = await testDb
    .select({
      id: schedulerJobs.id,
      nextRunAt: schedulerJobs.nextRunAt,
      lastSuccessAt: schedulerJobs.lastSuccessAt,
    })
    .from(schedulerJobs)
    .orderBy(schedulerJobs.id);
  expect(
    jobs.map(({ id, nextRunAt }) => ({
      id,
      nextRunAt: nextRunAt.toISOString(),
    })),
  ).toEqual(
    [
      { id: JOB_ID, nextRunAt: "2020-01-01T00:00:00.000Z" },
      { id: secondDueJobId, nextRunAt: "2020-01-01T00:00:00.000Z" },
      { id: futureJobId, nextRunAt: "2099-01-01T00:00:00.000Z" },
    ].toSorted((left, right) => compareCodeUnit(left.id, right.id)),
  );
  expect(jobs.find(({ id }) => id === futureJobId)?.lastSuccessAt).toBeNull();
});

test("a paused job that is still running refuses capture", async () => {
  await pauseAgentScheduler(db);
  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  await testDb
    .update(schedulerJobs)
    .set({ lockedBy: "background-runner", lockedUntil: new Date("2099-01-01") })
    .where(eq(schedulerJobs.id, JOB_ID));

  const pauseState = await assertAgentSchedulerPaused(db);
  expect(pauseState.isErr() ? pauseState.error : undefined).toBeInstanceOf(
    AgentSchedulerStateError,
  );
});

test.each(["success", "failure", "skipped"] as const)(
  "a one-shot paused job restores its pause before releasing its lease (%s)",
  async (outcome) => {
    await pauseAgentScheduler(db);
    const [initialPause] = await testDb
      .select({
        pausedBy: schedulerJobs.pausedBy,
        pauseReason: schedulerJobs.pauseReason,
        lockedBy: schedulerJobs.lockedBy,
        lockedUntil: schedulerJobs.lockedUntil,
      })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, JOB_ID));
    const cancellation = new AbortController();
    let executions = 0;
    const registry = new Map([
      [
        TASK_ID,
        async ({ db: taskDb, scheduleContinuation }: SchedulerTaskContext) => {
          executions += 1;
          const nested = await runSchedulerOnce({
            db: taskDb,
            registry: contentRegistry,
            runnerId: "background-during-settle",
            limit: 1,
          });
          expect(nested.acquired).toBe(0);
          if (outcome === "success") {
            scheduleContinuation(new Date("2020-01-01T00:00:00.000Z"));
            return;
          }
          if (outcome === "skipped") {
            cancellation.abort();
          }
          throw new SchedulerTaskFailure({
            message: "Fixture task stopped",
            cause: outcome,
          });
        },
      ],
    ]) satisfies SchedulerTaskRegistry;
    const recording = installRecordingLogger();
    try {
      const result = await runSchedulerOnce({
        db,
        registry,
        runPausedBy: "agent-stack",
        runnerId: "one-shot-settle",
        signal: cancellation.signal,
        limit: 1,
      });

      expect(executions).toBe(1);
      expect(result).toMatchObject({
        acquired: 1,
        succeeded: outcome === "success" ? 1 : 0,
        failed: outcome === "failure" ? 1 : 0,
        skipped: outcome === "skipped" ? 1 : 0,
      });
      expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
      const [restored] = await testDb
        .select({
          pausedBy: schedulerJobs.pausedBy,
          pauseReason: schedulerJobs.pauseReason,
          lockedBy: schedulerJobs.lockedBy,
          lockedUntil: schedulerJobs.lockedUntil,
        })
        .from(schedulerJobs)
        .where(eq(schedulerJobs.id, JOB_ID));
      expect(restored).toEqual(initialPause);
      expect(restored).toMatchObject({ lockedBy: null, lockedUntil: null });
      const background = await runSchedulerOnce({
        db,
        registry: contentRegistry,
        runnerId: "background-after-settle",
        eligibilityNow: () => new Date("2100-01-01T00:00:00.000Z").getTime(),
        limit: 1,
      });
      expect(background.acquired).toBe(0);
    } finally {
      recording.restore();
    }
  },
);

test("one-shot settling does not claim another operator's indefinite pause", async () => {
  await pauseAgentScheduler(db);
  await testDb
    .update(schedulerJobs)
    .set({ pausedBy: "another-operator", pauseReason: "Operator pause" })
    .where(eq(schedulerJobs.id, JOB_ID));

  const result = await runSchedulerOnce({
    db,
    registry: contentRegistry,
    runPausedBy: "agent-stack",
    runnerId: "one-shot-other-owner",
    limit: 1,
  });

  expect(result.acquired).toBe(0);
  expect(await readSeededName()).toBe("seed");
  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  const [paused] = await testDb
    .select({
      pausedBy: schedulerJobs.pausedBy,
      pauseReason: schedulerJobs.pauseReason,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, JOB_ID));
  expect(paused).toEqual({
    pausedBy: "another-operator",
    pauseReason: "Operator pause",
  });
});

test("one-shot completion preserves a later operator pause", async () => {
  await pauseAgentScheduler(db);
  const registry = new Map([
    [
      TASK_ID,
      async ({ db: taskDb }: SchedulerTaskContext) => {
        await taskDb
          .update(schedulerJobs)
          .set({
            pausedBy: "another-operator",
            pauseReason: "New operator pause",
            pausedUntil: sql`'infinity'::timestamptz`,
          })
          .where(eq(schedulerJobs.id, JOB_ID));
      },
    ],
  ]) satisfies SchedulerTaskRegistry;
  const recording = installRecordingLogger();
  try {
    const result = await runSchedulerOnce({
      db,
      registry,
      runPausedBy: "agent-stack",
      limit: 1,
    });
    expect(result.succeeded).toBe(1);
    expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
    const [paused] = await testDb
      .select({
        pausedBy: schedulerJobs.pausedBy,
        pauseReason: schedulerJobs.pauseReason,
      })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, JOB_ID));
    expect(paused).toEqual({
      pausedBy: "another-operator",
      pauseReason: "New operator pause",
    });
  } finally {
    recording.restore();
  }
});

test("pause and resume record changed-job counts once per state transition", async () => {
  await testDb.insert(schedulerJobs).values({
    id: "agent-stack.audit-second-job",
    description: "Another recurring job",
    task: TASK_ID,
    schedule: { type: "interval", everyMs: MINUTE_MS },
    nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
  });

  await pauseAgentScheduler(db);
  const pausedAudits = await readPauseAudits(db);
  expect(pausedAudits).toHaveLength(1);
  expect(pausedAudits.at(0)?.subject).toMatch(/^[0-9a-f-]{36}$/u);
  expect(pausedAudits.at(0)).toMatchObject({
    actor: PAUSE_AUDIT_ACTOR,
    counts: { pausedJobs: 2, resumedJobs: 0 },
  });
  expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(true);
  await pauseAgentScheduler(db);
  expect(await readPauseAudits(db)).toEqual(pausedAudits);

  await resumeAgentScheduler(db);
  const resumedAudits = await readPauseAudits(db);
  expect(resumedAudits).toHaveLength(2);
  expect(resumedAudits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: PAUSE_AUDIT_ACTOR,
        counts: { pausedJobs: 0, resumedJobs: 2 },
      }),
    ]),
  );
  expect((await assertAgentSchedulerPaused(db)).isErr()).toBe(true);
  await resumeAgentScheduler(db);
  expect(await readPauseAudits(db)).toEqual(resumedAudits);
});

test.each(["pause", "resume"] as const)(
  "%s and its audit row roll back in the same transaction",
  async (action) => {
    if (action === "resume") {
      await pauseAgentScheduler(db);
    }
    const before = await readTableDigests(db);
    const auditsBefore = await readPauseAudits(db);
    const rollback = await rejectionOf(
      withAggregateTransaction(db, async (tx) => {
        if (action === "pause") {
          await pauseAgentScheduler(tx);
        } else {
          await resumeAgentScheduler(tx);
        }
        const auditsInside = await readPauseAudits(tx);
        expect(auditsInside).toHaveLength(auditsBefore.length + 1);
        expect(auditsInside).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actor: PAUSE_AUDIT_ACTOR,
              counts: {
                pausedJobs: action === "pause" ? 1 : 0,
                resumedJobs: action === "resume" ? 1 : 0,
              },
            }),
          ]),
        );
        expect((await assertAgentSchedulerPaused(tx)).isOk()).toBe(
          action === "pause",
        );
        tx.rollback();
      }),
    );

    expect(rollback).toBeInstanceOf(TransactionRollbackError);
    expect(await readPauseAudits(db)).toEqual(auditsBefore);
    expect(changedSealTables(before, await readTableDigests(db))).toEqual([]);
    expect((await assertAgentSchedulerPaused(db)).isOk()).toBe(
      action === "resume",
    );
  },
);
