/**
 * Every document run queue is built by one owner, so a scenario must end the
 * same way on each of them. Each scenario below runs against the list
 * verification queue and the document review queue, on the database, through
 * each feature's own table, claim and transitions. Only the run's execution is
 * a stub, and the queue transport is a recording fake.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { documentReviewRuns, legalListVerificationRuns } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import {
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  PLAYBOOK_PIN_PROVENANCE,
} from "@/api/lib/document-review/run-contract";
import { documentReviewRunQueue } from "@/api/lib/document-review/run-queue";
import { listVerificationRunQueue } from "@/api/lib/lists/verification/run-queue";
import { STANDARD_DOCUMENT_RUN_LIMITS } from "@/api/lib/queue/document-run-queue";
import type { ReconcileQueuedRunsResult } from "@/api/lib/queue/reconcile-scan";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import {
  brandPersistedDocumentReviewRunId,
  brandPersistedListVerificationRunId,
} from "@/api/lib/safe-id-boundaries";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

// timeout: each scenario seeds runs and drives several transactions against
// the shared test database.
setDefaultTimeout(60_000);

const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
    "list-verification": [{ type: "organization", organizationId: ids.orgA }],
  });
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
});

const seededVerificationRuns: string[] = [];
const seededReviewRuns: string[] = [];

afterAll(async () => {
  if (seededVerificationRuns.length > 0) {
    await testDb.delete(legalListVerificationRuns).where(
      inArray(
        legalListVerificationRuns.id,
        seededVerificationRuns.map((id) =>
          brandPersistedListVerificationRunId(id),
        ),
      ),
    );
  }
  if (seededReviewRuns.length > 0) {
    await testDb.delete(documentReviewRuns).where(
      inArray(
        documentReviewRuns.id,
        seededReviewRuns.map((id) => brandPersistedDocumentReviewRunId(id)),
      ),
    );
  }
  await releaseRlsFixture();
});

/** A timestamp this far before the database's clock: the rows age on the
 *  same clock the sweeps compare them against. */
const ago = (interval: string) => sql<Date>`now() - ${interval}::interval`;

type SeedRun = {
  status: "queued" | "running" | "failed";
  /** How long ago the row was queued, or claimed when it is running. */
  age?: string;
};

type RunState = { status: string; errorCode: string | null } | undefined;

/** The execution a scenario stands in for the feature's own. */
type StubExecute = (args: {
  deadline: () => AbortSignal;
}) => Promise<"unsupported_format" | null>;

type Added = { data: unknown; jobId: string };

const recordingQueue = () => {
  const added: Added[] = [];
  const held = new Set<string>();
  return {
    added,
    queue: {
      add: async (_name: string, data: unknown, options: { jobId: string }) => {
        added.push({ data, jobId: options.jobId });
        held.add(options.jobId);
      },
      getJob: async (jobId: string) =>
        held.has(jobId)
          ? {
              getState: async () => "waiting" as const,
              remove: async () => {
                held.delete(jobId);
              },
              retry: async () => {},
            }
          : undefined,
    },
  };
};

type RecordingQueue = ReturnType<typeof recordingQueue>["queue"];

type QueueDriver = {
  seed: (options: SeedRun) => Promise<string>;
  read: (runId: string) => Promise<RunState>;
  process: (runId: string, execute: StubExecute) => Promise<void>;
  reconcileStuck: () => Promise<number>;
  reconcileQueued: (
    queue: RecordingQueue,
  ) => Promise<ReconcileQueuedRunsResult>;
  limits: unknown;
};

const timestamps = ({ status, age }: SeedRun) => ({
  ...(status === "queued" && age !== undefined ? { createdAt: ago(age) } : {}),
  ...(status === "running" ? { startedAt: ago(age ?? "1 second") } : {}),
});

const verificationDriver: QueueDriver = {
  seed: async (options) => {
    const id = createSafeId<"legalListVerificationRun">();
    seededVerificationRuns.push(id);
    await testDb.insert(legalListVerificationRuns).values({
      id,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      requestedBy: ids.userA1,
      entityId: ids.entityA1,
      // At most one active run per document: each run pins its own field.
      fileFieldId: createSafeId<"field">(),
      entityVersionId: ids.entityVersionA1,
      contentSha256: "a".repeat(64),
      evidence: {
        listId: toSafeId<"legalList">(Bun.randomUUIDv7()),
        facts: [],
      },
      pipelineVersion: 2,
      status: options.status,
      ...timestamps(options),
    });
    return id;
  },
  read: async (runId) =>
    (
      await testDb
        .select({
          status: legalListVerificationRuns.status,
          errorCode: legalListVerificationRuns.errorCode,
        })
        .from(legalListVerificationRuns)
        .where(
          eq(
            legalListVerificationRuns.id,
            brandPersistedListVerificationRunId(runId),
          ),
        )
    ).at(0),
  process: async (runId, execute) =>
    await listVerificationRunQueue.processRun({
      actor: createRootRunActor(
        {
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          runId,
        },
        brandPersistedListVerificationRunId,
        database,
      ),
      admission: testModelAdmission(ids.orgA),
      execute,
    }),
  reconcileStuck: async () =>
    await listVerificationRunQueue.reconcileStuck({
      db: asTestRaw<
        Parameters<typeof listVerificationRunQueue.reconcileStuck>[0]["db"]
      >(testDb),
    }),
  reconcileQueued: async (queue) =>
    (
      await listVerificationRunQueue.reconcileQueued({
        db: asTestRaw<
          Parameters<typeof listVerificationRunQueue.reconcileQueued>[0]["db"]
        >(testDb),
        queue,
      })
    ).unwrap(),
  limits: listVerificationRunQueue.limits,
};

const REVIEW_BASIS: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: PLAYBOOK_PIN_PROVENANCE.EPHEMERAL,
    definitionSnapshot: {
      name: "Run queue scenario",
      positions: { version: 3, items: [] },
      scope: null,
    },
  },
  references: [],
  perspective: NEUTRAL_PERSPECTIVE,
};

const reviewDriver: QueueDriver = {
  seed: async (options) => {
    const id = createSafeId<"documentReviewRun">();
    seededReviewRuns.push(id);
    await testDb.insert(documentReviewRuns).values({
      id,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      requestedBy: ids.userA1,
      entityId: ids.entityA1,
      // At most one active run per document: each run pins its own field.
      fileFieldId: createSafeId<"field">(),
      entityVersionId: ids.entityVersionA1,
      contentSha256: "a".repeat(64),
      basis: REVIEW_BASIS,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
      status: options.status,
      ...timestamps(options),
    });
    return id;
  },
  read: async (runId) =>
    (
      await testDb
        .select({
          status: documentReviewRuns.status,
          errorCode: documentReviewRuns.errorCode,
        })
        .from(documentReviewRuns)
        .where(
          eq(documentReviewRuns.id, brandPersistedDocumentReviewRunId(runId)),
        )
    ).at(0),
  process: async (runId, execute) =>
    await documentReviewRunQueue.processRun({
      actor: createRootRunActor(
        {
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          runId,
        },
        brandPersistedDocumentReviewRunId,
        database,
      ),
      admission: testModelAdmission(ids.orgA),
      execute,
    }),
  reconcileStuck: async () =>
    await documentReviewRunQueue.reconcileStuck({
      db: asTestRaw<
        Parameters<typeof documentReviewRunQueue.reconcileStuck>[0]["db"]
      >(testDb),
    }),
  reconcileQueued: async (queue) =>
    (
      await documentReviewRunQueue.reconcileQueued({
        db: asTestRaw<
          Parameters<typeof documentReviewRunQueue.reconcileQueued>[0]["db"]
        >(testDb),
        queue,
      })
    ).unwrap(),
  limits: documentReviewRunQueue.limits,
};

const QUEUES: [string, QueueDriver][] = [
  ["list verification", verificationDriver],
  ["document review", reviewDriver],
];

const jobIdFor = (runId: string) => createBullMqJobId(ids.wsA1, runId);

describe.each(QUEUES)("the %s run queue", (_name, driver) => {
  test("runs on the shared limits, with the run's budget inside the stuck cutoff", () => {
    expect(driver.limits).toBe(STANDARD_DOCUMENT_RUN_LIMITS);
    expect(STANDARD_DOCUMENT_RUN_LIMITS.runTimeoutMs).toBeLessThan(
      STANDARD_DOCUMENT_RUN_LIMITS.stuckRunningMs,
    );
  });

  test("claims a queued run before it executes, and leaves a success to the execution", async () => {
    const runId = await driver.seed({ status: "queued" });
    const seen: RunState[] = [];

    await driver.process(runId, async () => {
      seen.push(await driver.read(runId));
      return null;
    });

    expect(seen).toEqual([{ status: "running", errorCode: null }]);
    expect(await driver.read(runId)).toEqual({
      status: "running",
      errorCode: null,
    });
  });

  test("fails a run with the code its execution returns", async () => {
    const runId = await driver.seed({ status: "queued" });

    await driver.process(runId, async () => "unsupported_format");

    expect(await driver.read(runId)).toEqual({
      status: "failed",
      errorCode: "unsupported_format",
    });
  });

  test("fails a run whose execution throws as internal", async () => {
    const runId = await driver.seed({ status: "queued" });

    await driver.process(runId, async () => {
      throw new Error("Fixture execution failed");
    });

    expect(await driver.read(runId)).toEqual({
      status: "failed",
      errorCode: "internal",
    });
  });

  test("fails a run whose time budget runs out as internal", async () => {
    const runId = await driver.seed({ status: "queued" });
    const budgets: boolean[] = [];

    await driver.process(runId, async ({ deadline }) => {
      // The budget starts when the run's own work does, not at the claim.
      budgets.push(deadline().aborted);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    expect(budgets).toEqual([false]);
    expect(await driver.read(runId)).toEqual({
      status: "failed",
      errorCode: "internal",
    });
  });

  test("fails a running run past the stuck cutoff and leaves a younger one running", async () => {
    const stuck = await driver.seed({ status: "running", age: "31 minutes" });
    const working = await driver.seed({ status: "running", age: "29 minutes" });

    await driver.reconcileStuck();
    await driver.reconcileStuck();

    expect(await driver.read(stuck)).toEqual({
      status: "failed",
      errorCode: "internal",
    });
    expect(await driver.read(working)).toEqual({
      status: "running",
      errorCode: null,
    });
  });

  test("fails a queued run older than a day and leaves a younger backlog queued", async () => {
    const lost = await driver.seed({ status: "queued", age: "25 hours" });
    const backlogged = await driver.seed({ status: "queued", age: "23 hours" });

    await driver.reconcileStuck();

    expect(await driver.read(lost)).toEqual({
      status: "failed",
      errorCode: "internal",
    });
    expect(await driver.read(backlogged)).toEqual({
      status: "queued",
      errorCode: null,
    });
  });

  test("hands a queued run whose job was lost back to the queue exactly once", async () => {
    // The row commits before its job is added; a crash in between leaves a
    // run no worker holds a job for.
    const runId = await driver.seed({ status: "queued" });
    const { queue, added } = recordingQueue();

    await driver.reconcileQueued(queue);
    await driver.reconcileQueued(queue);

    const handedBack = added.filter(({ jobId }) => jobId === jobIdFor(runId));
    expect(handedBack).toHaveLength(1);
    expect(handedBack.at(0)?.data).toMatchObject({
      runId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    });
    expect(await driver.read(runId)).toEqual({
      status: "queued",
      errorCode: null,
    });
  });

  test("executes a re-delivered job once, and a terminal run never", async () => {
    const runId = await driver.seed({ status: "queued" });
    const finished = await driver.seed({ status: "failed" });
    const executions: string[] = [];
    const execute: StubExecute = async () => {
      executions.push(runId);
      return null;
    };

    await driver.process(runId, execute);
    await driver.process(runId, execute);
    await driver.process(finished, execute);

    expect(executions).toEqual([runId]);
    expect(await driver.read(finished)).toEqual({
      status: "failed",
      errorCode: null,
    });
  });
});
