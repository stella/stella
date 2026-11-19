import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { asc, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { keptTranscriptDeletions } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { ElevenLabsDeployment } from "@/api/lib/dictation/elevenlabs-deployment";
import type { KeptTranscriptDeleteOutcome } from "@/api/lib/dictation/kept-transcript-delete";
import {
  forgetKeptTranscript,
  KEPT_TRANSCRIPT_FIRST_SWEEP_DELAY_MS,
  recordKeptTranscript,
} from "@/api/lib/dictation/kept-transcript-store";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  KEPT_TRANSCRIPT_EVENTS,
  KEPT_TRANSCRIPT_REPORT_ATTEMPTS,
  runKeptTranscriptDeletions,
} from "@/api/lib/scheduler/tasks/kept-transcript-deletion";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const KEPT: ElevenLabsDeployment = {
  apiKey: "elevenlabs-fixture",
  environment: "default",
  zeroRetention: false,
};

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await db.delete(keptTranscriptDeletions).where(sql`true`);
});

afterAll(async () => {
  await releaseTestDb();
});

type Logged = { level: "error" | "info"; event: string; attributes: unknown };

const run = async ({
  deployment = KEPT,
  outcome = () => ({ type: "deleted" }),
}: {
  deployment?: ElevenLabsDeployment | null;
  outcome?: (transcriptionId: string) => KeptTranscriptDeleteOutcome;
} = {}) => {
  const logged: Logged[] = [];
  const asked: string[] = [];
  const context = asTestRaw<SchedulerTaskContext>({
    db,
    dueAt: DueSlot.of({ nextRunAt: NOW, lockedAt: NOW }),
    runId: toSafeId<"schedulerJobRun">(`run_${Bun.randomUUIDv7()}`),
    signal: new AbortController().signal,
    logger: {
      error: (event: string, attributes: unknown) => {
        logged.push({ level: "error", event, attributes });
      },
      info: (event: string, attributes: unknown) => {
        logged.push({ level: "info", event, attributes });
      },
    },
  });
  await runKeptTranscriptDeletions(context, {
    deployment,
    deleteTranscript: async ({ transcriptionId }) => {
      asked.push(transcriptionId);
      return await Promise.resolve(outcome(transcriptionId));
    },
  });
  return { logged, asked };
};

const insertKept = async ({
  transcriptionId,
  attempts = 0,
  due = true,
  recordedAgoMs = 5 * 60 * 1000,
}: {
  transcriptionId: string;
  attempts?: number;
  due?: boolean;
  recordedAgoMs?: number;
}) => {
  await db.insert(keptTranscriptDeletions).values({
    transcriptionId,
    environment: "default",
    attempts,
    nextAttemptAt: due
      ? sql`now() - interval '1 second'`
      : sql`now() + interval '1 hour'`,
    createdAt: sql`now() - (${recordedAgoMs} * interval '1 millisecond')`,
  });
};

const rows = async () =>
  await db
    .select({
      transcriptionId: keptTranscriptDeletions.transcriptionId,
      attempts: keptTranscriptDeletions.attempts,
      lastErrorCode: keptTranscriptDeletions.lastErrorCode,
      waitMs: sql<number>`extract(epoch from (${keptTranscriptDeletions.nextAttemptAt} - now())) * 1000`,
    })
    .from(keptTranscriptDeletions)
    .orderBy(asc(keptTranscriptDeletions.transcriptionId));

describe("kept transcript store", () => {
  test("records the provider id only, due after the request's own delete had its chance, once per id", async () => {
    await recordKeptTranscript({
      db,
      environment: "eu",
      transcriptionId: "mkIIQ7dqfmic6Mpb0fWR",
    });
    await recordKeptTranscript({
      db,
      environment: "eu",
      transcriptionId: "mkIIQ7dqfmic6Mpb0fWR",
    });
    const [stored, ...others] = await db
      .select({
        environment: keptTranscriptDeletions.environment,
        attempts: keptTranscriptDeletions.attempts,
        waitMs: sql<number>`extract(epoch from (${keptTranscriptDeletions.nextAttemptAt} - now())) * 1000`,
      })
      .from(keptTranscriptDeletions);
    expect(others).toEqual([]);
    expect(stored).toMatchObject({ environment: "eu", attempts: 0 });
    expect(Number(stored?.waitMs)).toBeGreaterThan(
      KEPT_TRANSCRIPT_FIRST_SWEEP_DELAY_MS - 60_000,
    );

    await forgetKeptTranscript({ db, transcriptionId: "mkIIQ7dqfmic6Mpb0fWR" });
    expect(await rows()).toEqual([]);
  });

  test("refuses an id the provider would not issue", async () => {
    expect(
      await rejectionOf(
        recordKeptTranscript({
          db,
          environment: "default",
          transcriptionId: "../escape",
        }),
      ),
    ).toBeDefined();
  });
});

describe("kept transcript deletion task", () => {
  test("deletes due transcripts, backs off refused ones and leaves the rest", async () => {
    await insertKept({ transcriptionId: "gone" });
    await insertKept({ transcriptionId: "refused", attempts: 2 });
    await insertKept({ transcriptionId: "later", due: false });

    const { asked, logged } = await run({
      outcome: (id) =>
        id === "refused"
          ? { type: "failed", code: "http_503" }
          : { type: "deleted" },
    });

    expect(asked.toSorted()).toEqual(["gone", "refused"]);
    const remaining = await rows();
    expect(remaining.map(({ transcriptionId }) => transcriptionId)).toEqual([
      "later",
      "refused",
    ]);
    const refused = remaining.find(
      ({ transcriptionId }) => transcriptionId === "refused",
    );
    expect(refused).toMatchObject({ attempts: 3, lastErrorCode: "http_503" });
    // Two failed attempts before this one back off four minutes.
    expect(Number(refused?.waitMs)).toBeGreaterThan(3 * 60 * 1000);
    expect(Number(refused?.waitMs)).toBeLessThan(5 * 60 * 1000);
    expect(logged.filter(({ level }) => level === "error")).toEqual([]);
  });

  test("reports a transcript whose delete keeps failing", async () => {
    await insertKept({
      transcriptionId: "stuck",
      attempts: KEPT_TRANSCRIPT_REPORT_ATTEMPTS - 1,
    });
    const { logged } = await run({
      outcome: () => ({ type: "failed", code: "http_401" }),
    });
    expect(logged).toContainEqual({
      level: "error",
      event: KEPT_TRANSCRIPT_EVENTS.deleteFailing,
      attributes: {
        "keptTranscript.id": "stuck",
        "keptTranscript.attempts": KEPT_TRANSCRIPT_REPORT_ATTEMPTS,
        "keptTranscript.lastErrorCode": "http_401",
      },
    });
    const [stuck] = await rows();
    // Backoff stops growing at an hour.
    expect(Number(stuck?.waitMs)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test("reports a transcript still kept an hour after it was recorded, even before it is due", async () => {
    await insertKept({
      transcriptionId: "overdue",
      due: false,
      recordedAgoMs: 2 * 60 * 60 * 1000,
    });
    await insertKept({ transcriptionId: "recent", due: false });
    const { logged } = await run();
    const overdue = logged.filter(
      ({ event }) => event === KEPT_TRANSCRIPT_EVENTS.overdue,
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({
      level: "error",
      attributes: {
        "keptTranscript.overdue": "1",
        "keptTranscript.ids": "overdue",
      },
    });
  });

  test("does nothing on a deployment with zero retention or without a key", async () => {
    await insertKept({ transcriptionId: "kept" });
    for (const deployment of [{ ...KEPT, zeroRetention: true }, null]) {
      const { asked, logged } = await run({ deployment });
      expect(asked).toEqual([]);
      expect(logged).toEqual([]);
    }
    expect(await rows()).toHaveLength(1);
  });
});
