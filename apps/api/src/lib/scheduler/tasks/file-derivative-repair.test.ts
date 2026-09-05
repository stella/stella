/**
 * A derivative whose job never reached the queue has nothing left to drive
 * it. What is asserted here is the part no type can hold: that such a field
 * is handed back to the queue, that a derivative the worker already ruled out
 * is never resurrected, and that one tick cannot re-add an unbounded number
 * of jobs. Driven against a real (PGlite) database with a stubbed queue.
 */

import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import {
  entities,
  entityVersions,
  fields,
  schedulerJobs,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import {
  FILE_DERIVATIVE_KIND,
  requeueFileDerivative,
} from "@/api/lib/file-derivative-queue";
import type { RequeueFileDerivativeDependencies } from "@/api/lib/file-derivative-queue";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { logger } from "@/api/lib/observability/logger";
import type { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

type QueuedJob = {
  data: { derivativeFileId?: string; fieldId: string };
  name: string;
  opts: { jobId: string };
};

const queued: QueuedJob[] = [];
const priorJobs = new Map<
  string,
  { data: { derivativeFileId?: string; fieldId: string }; state: string }
>();
const removedJobIds: string[] = [];
const failingAddJobIds = new Set<string>();

class StubQueue {
  async add(name: string, data: QueuedJob["data"], opts: QueuedJob["opts"]) {
    if (failingAddJobIds.has(opts.jobId)) {
      throw new Error("queue write refused");
    }
    queued.push({ data, name, opts });
  }

  async getJob(jobId: string) {
    const job = priorJobs.get(jobId);
    if (!job) {
      return undefined;
    }
    return await Promise.resolve({
      data: job.data,
      getState: async () => await Promise.resolve(job.state),
      remove: async () => {
        priorJobs.delete(jobId);
        removedJobIds.push(jobId);
      },
    });
  }
}

const { REPAIR_FILE_DERIVATIVES_TASK, createRepairFileDerivativesTask } =
  await import("@/api/lib/scheduler/tasks/file-derivative-repair");
const requeueDependencies = {
  createRootScopedDb: () =>
    asTestRaw<ReturnType<typeof createRootScopedDb>>(
      async (run: Parameters<ReturnType<typeof createRootScopedDb>>[0]) =>
        await testDb.transaction(
          async (tx) => await run(asTestRaw<Parameters<typeof run>[0]>(tx)),
        ),
    ),
  getQueue: () =>
    asTestRaw<
      ReturnType<NonNullable<RequeueFileDerivativeDependencies["getQueue"]>>
    >(new StubQueue()),
  markFailed: async () => undefined,
} satisfies RequeueFileDerivativeDependencies;
const repairFileDerivatives = createRepairFileDerivativesTask({
  db: testDb,
  requeue: async (args) =>
    await requeueFileDerivative(args, requeueDependencies),
});

const SCHEDULER_JOB_ID = "test.files.repairDerivatives";
const LEASE_TOKEN = "test-lease";
const REQUEUE_LIMIT = 50;
const SETTLED_AT = new Date(Date.now() - 60 * 60 * 1000);
const RTF_MIME_TYPE = "application/rtf";
const PNG_MIME_TYPE = "image/png";

type SeedFieldOptions = {
  createdAt?: Date;
  mimeType?: string;
  pdfDerivative?: Extract<FieldContent, { type: "file" }>["pdfDerivative"];
  pdfFileId?: string | null;
  thumbnailDerivative?: Extract<
    FieldContent,
    { type: "file" }
  >["thumbnailDerivative"];
};

const seededFieldIds: SafeId<"field">[] = [];
const seededEntityIds: SafeId<"entity">[] = [];

/**
 * One document with its own current version, because a field is unique per
 * (property, version) and the sweep only looks at current versions.
 */
const seedFileField = async ({
  createdAt = SETTLED_AT,
  mimeType = RTF_MIME_TYPE,
  pdfDerivative = { status: "pending" },
  pdfFileId = null,
  thumbnailDerivative = { status: "not-required" },
}: SeedFieldOptions = {}): Promise<SafeId<"field">> => {
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  seededEntityIds.push(entityId);
  seededFieldIds.push(fieldId);

  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "Derivative repair document",
    createdBy: ids.userA1,
  });
  await testDb.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId: ids.wsA1,
    entityId,
    createdAt,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: entityVersionId })
    .where(eq(entities.id, entityId));
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId: ids.wsA1,
    propertyId: ids.propertyA1,
    entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: allocateFileObject(),
      fileName: "podani.rtf",
      mimeType,
      sizeBytes: 12,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId,
      pdfDerivative,
      thumbnailFileId: null,
      thumbnailDerivative,
    },
  });
  return fieldId;
};

const readDerivativeStatus = async (fieldId: SafeId<"field">) => {
  const row = await testDb.query.fields.findFirst({
    columns: { content: true },
    where: { id: { eq: fieldId } },
  });
  return row?.content.type === "file" ? row.content.pdfDerivative : undefined;
};

const runRepair = async () => {
  const job = await testDb.query.schedulerJobs.findFirst({
    where: { id: { eq: SCHEDULER_JOB_ID } },
  });
  if (!job) {
    panic("expected the repair scheduler job row");
  }
  await repairFileDerivatives({
    job,
    payload: job.payload,
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: () => undefined,
    signal: new AbortController().signal,
    logger,
  });
};

const jobIdsFor = (kind: string) =>
  queued.filter(({ opts }) => opts.jobId.endsWith(`-${kind}`));

describe("file derivative repair", () => {
  let analytics: RecordingAnalytics;

  beforeEach(async () => {
    analytics = installRecordingAnalytics();
    queued.length = 0;
    removedJobIds.length = 0;
    priorJobs.clear();
    failingAddJobIds.clear();
    await testDb
      .insert(schedulerJobs)
      .values({
        id: SCHEDULER_JOB_ID,
        task: REPAIR_FILE_DERIVATIVES_TASK,
        schedule: { type: "interval", everyMs: 300_000 },
        nextRunAt: new Date(),
        lockedBy: LEASE_TOKEN,
        payload: { cursor: null },
      })
      .onConflictDoUpdate({
        target: schedulerJobs.id,
        set: { lockedBy: LEASE_TOKEN, payload: { cursor: null } },
      });
  });

  // Each test owns its rows: a field left behind is still stuck, and the
  // next test's sweep would pick it up along with its own.
  afterEach(async () => {
    analytics.restore();
    if (seededFieldIds.length > 0) {
      await testDb.delete(fields).where(inArray(fields.id, seededFieldIds));
      await testDb
        .delete(entities)
        .where(inArray(entities.id, seededEntityIds));
    }
    seededFieldIds.length = 0;
    seededEntityIds.length = 0;
  });

  afterAll(async () => {
    try {
      await testDb
        .delete(schedulerJobs)
        .where(eq(schedulerJobs.id, SCHEDULER_JOB_ID));
    } finally {
      await releaseRlsFixture();
    }
  });

  test("requeues what is stuck and leaves terminal verdicts alone", async () => {
    const stuckPending = await seedFileField();
    const enqueueFailed = await seedFileField({
      pdfDerivative: { status: "failed", reason: "enqueue" },
    });
    const processingFailed = await seedFileField({
      pdfDerivative: { status: "failed", reason: "processing" },
    });
    // Written before the reason existed: read as terminal, because
    // replaying a real processing failure is the costlier mistake.
    const legacyFailed = await seedFileField({
      pdfDerivative: { status: "failed" },
    });
    const ready = await seedFileField({
      pdfDerivative: { status: "ready" },
      pdfFileId: allocateFileObject(),
    });
    const stuckThumbnail = await seedFileField({
      mimeType: PNG_MIME_TYPE,
      pdfDerivative: { status: "not-required" },
      thumbnailDerivative: { status: "pending" },
    });
    // Still inside the settle window: the queue may well be working on it.
    const freshUpload = await seedFileField({ createdAt: new Date() });

    await runRepair();

    expect(queued.map(({ data }) => data.fieldId).toSorted()).toEqual(
      [stuckPending, enqueueFailed, stuckThumbnail].toSorted(),
    );
    expect(jobIdsFor(FILE_DERIVATIVE_KIND.THUMBNAIL)).toHaveLength(1);
    // The retried enqueue failure is back in the pending state its job reads.
    expect(await readDerivativeStatus(enqueueFailed)).toEqual({
      status: "pending",
    });
    expect(await readDerivativeStatus(processingFailed)).toEqual({
      status: "failed",
      reason: "processing",
    });
    expect(await readDerivativeStatus(legacyFailed)).toEqual({
      status: "failed",
    });
    expect(await readDerivativeStatus(ready)).toEqual({ status: "ready" });
    expect(await readDerivativeStatus(freshUpload)).toEqual({
      status: "pending",
    });
  });

  test("reclaims a retained job id so the retry is not swallowed", async () => {
    const fieldId = await seedFileField();
    const jobId = createBullMqJobId(
      ids.wsA1,
      fieldId,
      FILE_DERIVATIVE_KIND.PDF,
    );
    const derivativeFileId = allocateFileObject();
    priorJobs.set(jobId, {
      data: { derivativeFileId, fieldId },
      state: "completed",
    });

    await runRepair();

    expect(removedJobIds).toContain(jobId);
    // The dead job's derivative object id is replayed, so the retry writes
    // over what the previous attempt left in storage instead of orphaning it.
    expect(
      queued.find((job) => job.opts.jobId === jobId)?.data.derivativeFileId,
    ).toBe(derivativeFileId);
  });

  test("leaves a live job alone", async () => {
    const fieldId = await seedFileField();
    const jobId = createBullMqJobId(
      ids.wsA1,
      fieldId,
      FILE_DERIVATIVE_KIND.PDF,
    );
    priorJobs.set(jobId, { data: { fieldId }, state: "active" });

    await runRepair();

    expect(queued).toHaveLength(0);
    expect(removedJobIds).toHaveLength(0);
  });

  test("bounds one tick and resumes from its cursor", async () => {
    // Sequential seeding: each row's id must sort after the previous one, so
    // the cursor's resume point is checkable.
    const seeded: SafeId<"field">[] = [];
    const seedNext = async (remaining: number): Promise<void> => {
      if (remaining === 0) {
        return;
      }
      seeded.push(await seedFileField());
      await seedNext(remaining - 1);
    };
    await seedNext(REQUEUE_LIMIT + 2);

    await runRepair();
    expect(queued).toHaveLength(REQUEUE_LIMIT);

    const [job] = await testDb
      .select({ payload: schedulerJobs.payload })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, SCHEDULER_JOB_ID));
    expect(job?.payload).toEqual({ cursor: seeded[REQUEUE_LIMIT - 1] });

    queued.length = 0;
    await runRepair();
    expect(queued.map(({ data }) => data.fieldId)).toEqual(
      seeded.slice(REQUEUE_LIMIT),
    );
  });

  // The pre-hardening bare `::jsonb` casts stored the serialized state as a
  // jsonb *string*. Such a row used to panic the sweep mid-scan, which pinned
  // the cursor on it and re-captured the same failure every tick.
  test("reports a state it cannot read, skips it, and keeps sweeping", async () => {
    const corrupt = await seedFileField();
    const stuck = await seedFileField();
    await testDb.execute(
      sql`update ${fields}
        set content = jsonb_set(content, '{pdfDerivative}', to_jsonb('{"status":"pending"}'::text), true)
        where id = ${corrupt}`,
    );

    await runRepair();

    expect(queued.map(({ data }) => data.fieldId)).toEqual([stuck]);
    const reported = analytics
      .exceptions()
      .map((event) => event.properties)
      .filter(
        (properties) =>
          properties["error.class"] === "UnrecognizedDerivativeStateError",
      );
    expect(reported.map((properties) => properties["fieldId"])).toEqual([
      corrupt,
    ]);
    // The tick finished: the cursor moved past both rows.
    const [job] = await testDb
      .select({ payload: schedulerJobs.payload })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, SCHEDULER_JOB_ID));
    expect(job?.payload).toEqual({ cursor: stuck });
  });

  // A status this build does not know: what a newer writer leaves behind. The
  // column's Drizzle type does not describe it, so the read boundary is what
  // keeps it from reaching the classifier as a state nobody handled.
  test("reports a status it does not know and leaves the row alone", async () => {
    const unknownStatus = await seedFileField();
    const stuck = await seedFileField();
    await testDb.execute(
      sql`update ${fields}
        set content = jsonb_set(content, '{pdfDerivative}', '{"status":"converting"}'::jsonb, true)
        where id = ${unknownStatus}`,
    );

    await runRepair();

    expect(queued.map(({ data }) => data.fieldId)).toEqual([stuck]);
    const reported = analytics
      .exceptions()
      .map((event) => event.properties)
      .filter(
        (properties) =>
          properties["error.class"] === "UnrecognizedDerivativeStateError",
      );
    expect(reported.map((properties) => properties["fieldId"])).toEqual([
      unknownStatus,
    ]);
    // Read as `unknown`: the column's type cannot describe a status this build
    // does not know, which is the whole point of the row.
    const stored: unknown = await readDerivativeStatus(unknownStatus);
    expect(stored).toEqual({ status: "converting" });
  });

  // A row whose repair throws stops the tick (the queue may be down), but the
  // cursor still moves past it: the next tick continues behind the row
  // instead of replaying the same failure forever and starving what follows.
  test("advances the cursor past a row whose repair throws", async () => {
    const failing = await seedFileField();
    const stuck = await seedFileField();
    failingAddJobIds.add(
      createBullMqJobId(ids.wsA1, failing, FILE_DERIVATIVE_KIND.PDF),
    );

    await runRepair();

    expect(queued).toHaveLength(0);
    expect(
      analytics
        .exceptions()
        .some(
          ({ properties }) =>
            properties["error.class"] === "FileDerivativeRepairError",
        ),
    ).toBe(true);

    await runRepair();

    expect(queued.map(({ data }) => data.fieldId)).toEqual([stuck]);
  });
});
