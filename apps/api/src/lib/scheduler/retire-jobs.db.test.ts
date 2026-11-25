import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

import { retireSchedulerJobs } from "./jobs";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const insertJob = async (id: string, task: string) => {
  await rootDb.insert(schedulerJobs).values({
    id,
    task,
    schedule: { type: "interval", everyMs: 60_000 },
    nextRunAt: new Date("2026-11-25T08:00:00.000Z"),
  });
};

test("registration retires only removed tasks and leaves a newer build's task running", async () => {
  const suffix = Bun.randomUUIDv7();
  const removed = { id: `retire.removed.${suffix}`, task: `removed.${suffix}` };
  const newer = { id: `retire.newer.${suffix}`, task: `newer.${suffix}` };
  await insertJob(removed.id, removed.task);
  await insertJob(newer.id, newer.task);

  await retireSchedulerJobs(new Set([removed.task]));

  const rows = await rootDb
    .select({ id: schedulerJobs.id, enabled: schedulerJobs.enabled })
    .from(schedulerJobs)
    .where(inArray(schedulerJobs.id, [removed.id, newer.id]));
  expect(
    Object.fromEntries(rows.map(({ id, enabled }) => [id, enabled])),
  ).toEqual({ [removed.id]: false, [newer.id]: true });
});
