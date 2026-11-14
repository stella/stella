import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { JOURNEY_PREREQUISITE } from "@stll/api-contract/journey-prerequisites";
import { dbClock } from "@stll/test-kit/db";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import {
  bringJourneyPrerequisitesForward,
  readJourneyPrerequisites,
} from "@/api/lib/smoke-session/store";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: the first test waits for the PGlite database to load its schema.
setDefaultTimeout(120_000);

const JOURNEY = JOURNEY_PREREQUISITE.sanctionsScreening;
const SANCTIONS_JOB_ID = "sanctions.refreshSources.twoHourly";
/** Any other declared recurring job, overdue for longer than the sanctions job. */
const OLDER_JOB_ID = "desktopEditSessions.expire.hourly";
const JOB_IDS = [SANCTIONS_JOB_ID, OLDER_JOB_ID];
/** The instant the journey brought its jobs forward. */
const SINCE = new Date("2026-11-08T20:25:00.000Z");
const SANCTIONS_DUE = new Date("2026-11-06T07:00:00.000Z");
const at = (offsetMs: number) => new Date(SINCE.getTime() + offsetMs);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterEach(async () => {
  await testDb.delete(schedulerJobs).where(inArray(schedulerJobs.id, JOB_IDS));
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const declaredJob = (id: string) => {
  const declared = DECLARED_SCHEDULER_JOBS.find((job) => job.id === id);
  if (declared === undefined) {
    throw new Error(`${id} is not a declared scheduler job`);
  }
  return { id, task: declared.task, schedule: declared.schedule };
};

const insertRun = async (
  values: Pick<
    typeof schedulerJobRuns.$inferInsert,
    "error" | "finishedAt" | "startedAt" | "status"
  >,
) => {
  await testDb.insert(schedulerJobRuns).values({
    jobId: SANCTIONS_JOB_ID,
    task: "sanctions.refreshSources",
    runnerId: "test-runner",
    ...values,
  });
};

const readJob = async (id: string) => {
  const [row] = await testDb
    .select({
      nextRunAt: schedulerJobs.nextRunAt,
      pausedUntil: schedulerJobs.pausedUntil,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, id));
  return row;
};

describe("journey prerequisite jobs (database)", () => {
  test("brings the journey's job ahead of every other overdue job", async () => {
    const oldest = new Date("2026-11-01T00:00:00.000Z");
    await testDb.insert(schedulerJobs).values([
      { ...declaredJob(OLDER_JOB_ID), nextRunAt: oldest },
      { ...declaredJob(SANCTIONS_JOB_ID), nextRunAt: SANCTIONS_DUE },
    ]);

    const moved = await bringJourneyPrerequisitesForward(JOURNEY);

    expect(moved.map(({ id }) => id)).toEqual([SANCTIONS_JOB_ID]);
    const sanctions = await readJob(SANCTIONS_JOB_ID);
    expect(sanctions?.nextRunAt.getTime()).toBeLessThan(oldest.getTime());
    expect((await readJob(OLDER_JOB_ID))?.nextRunAt).toEqual(oldest);
  });

  test("leaves a paused job alone and reports it as failed", async () => {
    await testDb.insert(schedulerJobs).values({
      ...declaredJob(SANCTIONS_JOB_ID),
      nextRunAt: SANCTIONS_DUE,
      pausedBy: "test-operator",
      pausedSince: dbClock.now(),
      pausedUntil: dbClock.fromNow(60 * 60_000),
      pauseReason: "Scheduler maintenance",
    });
    const pausedUntil = (await readJob(SANCTIONS_JOB_ID))?.pausedUntil;
    if (pausedUntil === undefined || pausedUntil === null) {
      throw new Error("The paused job lost its pause");
    }

    expect(await bringJourneyPrerequisitesForward(JOURNEY)).toEqual([]);
    expect((await readJob(SANCTIONS_JOB_ID))?.nextRunAt).toEqual(SANCTIONS_DUE);
    expect(await readJourneyPrerequisites(JOURNEY, SINCE)).toEqual([
      {
        jobId: SANCTIONS_JOB_ID,
        state: "failed",
        detail: `${SANCTIONS_JOB_ID} is paused until ${pausedUntil.toISOString()}`,
      },
    ]);
  });

  test("waits while only runs from before the journey exist", async () => {
    await testDb
      .insert(schedulerJobs)
      .values({ ...declaredJob(SANCTIONS_JOB_ID), nextRunAt: SANCTIONS_DUE });
    await insertRun({
      status: "failed",
      startedAt: at(-10 * 60_000),
      finishedAt: at(-9 * 60_000),
      error: "EarlierFailure",
    });

    expect(await readJourneyPrerequisites(JOURNEY, SINCE)).toEqual([
      {
        jobId: SANCTIONS_JOB_ID,
        state: "pending",
        detail: `${SANCTIONS_JOB_ID} is due at ${SANCTIONS_DUE.toISOString()} and not yet claimed`,
      },
    ]);
  });

  test("reports a run that failed since the journey with the run's error", async () => {
    await testDb
      .insert(schedulerJobs)
      .values({ ...declaredJob(SANCTIONS_JOB_ID), nextRunAt: SANCTIONS_DUE });
    // Started before the journey brought it forward, finished after.
    await insertRun({
      status: "failed",
      startedAt: at(-30_000),
      finishedAt: at(1000),
      error: "SchedulerJobTimeout",
    });

    expect(await readJourneyPrerequisites(JOURNEY, SINCE)).toEqual([
      {
        jobId: SANCTIONS_JOB_ID,
        state: "failed",
        detail: `${SANCTIONS_JOB_ID} run started ${at(-30_000).toISOString()} failed: SchedulerJobTimeout`,
      },
    ]);
  });

  test("judges the latest of several runs since the journey", async () => {
    await testDb
      .insert(schedulerJobs)
      .values({ ...declaredJob(SANCTIONS_JOB_ID), nextRunAt: SANCTIONS_DUE });
    await insertRun({
      status: "skipped",
      startedAt: at(1000),
      finishedAt: at(2000),
      error: "SchedulerLeaseLost",
    });
    await insertRun({
      status: "running",
      startedAt: at(5000),
      finishedAt: null,
      error: null,
    });

    expect(await readJourneyPrerequisites(JOURNEY, SINCE)).toEqual([
      {
        jobId: SANCTIONS_JOB_ID,
        state: "pending",
        detail: `${SANCTIONS_JOB_ID} has been running since ${at(5000).toISOString()}`,
      },
    ]);
  });

  test("holds a successful run to the list it should have refreshed", async () => {
    await testDb
      .insert(schedulerJobs)
      .values({ ...declaredJob(SANCTIONS_JOB_ID), nextRunAt: SANCTIONS_DUE });
    await insertRun({
      status: "success",
      startedAt: at(1000),
      finishedAt: at(2000),
      error: null,
    });

    // No EU edition was ever loaded in this database.
    expect(await readJourneyPrerequisites(JOURNEY, SINCE)).toEqual([
      {
        jobId: SANCTIONS_JOB_ID,
        state: "failed",
        detail: `${SANCTIONS_JOB_ID} ran, but eu not-loaded (never verified)`,
      },
    ]);
  });
});
