import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  legalListVerificationRuns,
  properties,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import {
  createVerificationCall,
  ListVerificationAccessRevokedError,
} from "@/api/lib/lists/verification/model-call";
import { failVerificationRun } from "@/api/lib/lists/verification/run-persistence";
import {
  processListVerificationRun,
  reconcileQueuedListVerificationRuns,
  reconcileStuckListVerificationRuns,
  resolveListVerificationRunAccess,
} from "@/api/lib/lists/verification/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const organizationId = toSafeId<"organization">(
  `verification-queue-${Bun.randomUUIDv7()}`,
);
const workspaceId = createSafeId<"workspace">();
const userId = toSafeId<"user">(`verification-requester-${Bun.randomUUIDv7()}`);
const organizationMemberId = Bun.randomUUIDv7();
const workspaceMemberId = createSafeId<"workspaceMember">();
const grants = {
  [LIST_VERIFICATION_FEATURE_ID]: [{ type: "organization", organizationId }],
} satisfies FeatureAccessGrants;

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values({
    id: organizationId,
    name: "Queue fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Queue requester",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: organizationMemberId,
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Queue matter",
    reference: Bun.randomUUIDv7(),
  });
  await db
    .insert(workspaceMembers)
    .values({ id: workspaceMemberId, workspaceId, userId });
});
afterAll(async () => await releaseTestDb());

const seedRun = async (status: "queued" | "running" = "queued") => {
  const id = createSafeId<"legalListVerificationRun">();
  await db.insert(legalListVerificationRuns).values({
    id,
    organizationId,
    workspaceId,
    requestedBy: userId,
    entityId: createSafeId<"entity">(),
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    evidence: { listId: createSafeId<"legalList">(), facts: [] },
    pipelineVersion: 2,
    status,
    startedAt:
      status === "running" ? new Date(Date.now() - 60 * 60 * 1000) : null,
  });
  return id;
};

const seedPinnedRun = async () => {
  const runId = await seedRun();
  const run = (
    await db
      .select()
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.id, runId))
  ).at(0);
  if (run === undefined) {
    throw new Error("Expected pinned run fixture");
  }
  await db
    .insert(entities)
    .values({ id: run.entityId, workspaceId, name: "Verification document" });
  await db
    .insert(entityVersions)
    .values({ id: run.entityVersionId, entityId: run.entityId, workspaceId });
  const propertyId = createSafeId<"property">();
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "Verification file",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await db.insert(fields).values({
    id: run.fileFieldId,
    workspaceId,
    entityVersionId: run.entityVersionId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: Bun.randomUUIDv7(),
      fileName: "fixture.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: run.contentSha256,
      pdfFileId: null,
    },
  });
  return runId;
};

type ExecutionRevocation = "matter" | "grant" | "deployment" | "active";
const revokeExecutionPrerequisite = async (kind: ExecutionRevocation) => {
  switch (kind) {
    case "matter":
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, workspaceMemberId));
      return async () => {
        await db
          .insert(workspaceMembers)
          .values({ id: workspaceMemberId, workspaceId, userId });
      };
    case "grant":
      env.API_FEATURE_ACCESS_GRANTS = {};
      return async () => {};
    case "deployment":
      env.FEATURE_LEGAL_LISTS = false;
      return async () => {};
    case "active":
      await db
        .update(workspaces)
        .set({ status: "archived" })
        .where(eq(workspaces.id, workspaceId));
      return async () => {
        await db
          .update(workspaces)
          .set({ status: "active" })
          .where(eq(workspaces.id, workspaceId));
      };
    default:
      kind satisfies never;
      return panic("Unknown execution prerequisite");
  }
};

const withProductionPrerequisites = async (run: () => Promise<void>) => {
  const previousGrants = env.API_FEATURE_ACCESS_GRANTS;
  const previousDeployment = env.FEATURE_LEGAL_LISTS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  env.FEATURE_LEGAL_LISTS = true;
  env.API_FEATURE_ACCESS_GRANTS = grants;
  try {
    await run();
  } finally {
    env.API_FEATURE_ACCESS_GRANTS = previousGrants;
    env.FEATURE_LEGAL_LISTS = previousDeployment;
    restoreMode();
  }
};

const actorFor = (
  runId: SafeId<"legalListVerificationRun">,
  database: TestDatabase = db,
) =>
  createRootRunActor(
    { organizationId, userId, workspaceId, runId },
    brandPersistedListVerificationRunId,
    asTestRaw<RlsDatabase<Transaction>>(database),
  );
const readRun = async (id: SafeId<"legalListVerificationRun">) =>
  (
    await db
      .select({
        status: legalListVerificationRuns.status,
        errorCode: legalListVerificationRuns.errorCode,
      })
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.id, id))
  ).at(0);
const readAudits = async (id: string) =>
  await db
    .select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resourceId, id),
        eq(auditLogs.resourceType, "legal_list_verification"),
      ),
    );

const assertActiveSlotReleased = async (
  runId: SafeId<"legalListVerificationRun">,
) => {
  const original = (
    await db
      .select()
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.id, runId))
  ).at(0);
  if (original === undefined) {
    throw new Error("Expected terminal run fixture");
  }
  const replacementId = createSafeId<"legalListVerificationRun">();
  await db.insert(legalListVerificationRuns).values({
    ...original,
    id: replacementId,
    status: "queued",
    errorCode: null,
    finishedAt: null,
  });
  await db
    .delete(legalListVerificationRuns)
    .where(eq(legalListVerificationRuns.id, replacementId));
};

const queueFixture = () => {
  const added: unknown[] = [];
  const jobs = new Set<string>();
  return {
    added,
    queue: {
      add: async (_name: string, data: unknown, options: { jobId: string }) => {
        added.push(data);
        jobs.add(options.jobId);
      },
      getJob: async (id: string) =>
        jobs.has(id)
          ? {
              getState: async () => "waiting" as const,
              remove: async () => {
                jobs.delete(id);
              },
              retry: async () => {},
            }
          : undefined,
    },
  };
};

test("queued revocation fails once and makes no execution call", async () => {
  const runId = await seedRun();
  let calls = 0;
  const args = {
    data: { runId, organizationId, workspaceId, userId },
    admission: testModelAdmission(organizationId),
    actor: actorFor(runId),
    grants: {},
    execute: async () => {
      calls += 1;
      return null;
    },
  };
  await processListVerificationRun(args);
  await processListVerificationRun(args);
  expect(calls).toBe(0);
  expect(await readRun(runId)).toEqual({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(await readAudits(runId)).toEqual([
    {
      userId,
      metadata: {
        runId,
        status: "failed",
        errorCode: "access_revoked",
        blockCount: 0,
        claimCount: 0,
      },
    },
  ]);
  const original = (
    await db
      .select()
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.id, runId))
  ).at(0);
  if (original === undefined) {
    throw new Error("Expected run fixture");
  }
  await db.insert(legalListVerificationRuns).values({
    ...original,
    id: createSafeId<"legalListVerificationRun">(),
    status: "queued",
    errorCode: null,
    finishedAt: null,
  });
  await db
    .update(legalListVerificationRuns)
    .set({ status: "failed", errorCode: "internal" })
    .where(eq(legalListVerificationRuns.entityId, original.entityId));
});

test("access is rechecked after resolving the pinned file before reading document bytes", async () =>
  await withProductionPrerequisites(async () => {
    const runId = await seedPinnedRun();
    const documentReads: string[] = [];
    let revokedAtFileLookup = false;
    const database = withQueryLogger(db, {
      logQuery: (query) => {
        if (query.includes('from "fields"')) {
          revokedAtFileLookup = true;
          env.API_FEATURE_ACCESS_GRANTS = {};
        }
      },
    });
    await processListVerificationRun({
      data: { runId, organizationId, workspaceId, userId },
      admission: testModelAdmission(organizationId),
      actor: actorFor(runId, database),
      execution: {
        readDocument: async ({ file }) => {
          documentReads.push(file.fileId);
          return { type: "no-text" };
        },
      },
    });
    expect(revokedAtFileLookup).toBe(true);
    expect(documentReads).toHaveLength(0);
    expect(await readRun(runId)).toEqual({
      status: "failed",
      errorCode: "access_revoked",
    });
    expect(await readAudits(runId)).toHaveLength(1);
  }));

test.each(["matter", "grant", "deployment", "active"] as const)(
  "queued %s removal makes zero document reads and model dispatches",
  async (kind) =>
    await withProductionPrerequisites(async () => {
      const documentReads: string[] = [];
      const modelDispatches: unknown[] = [];
      const execution = {
        readDocument: async ({
          file,
        }: Parameters<typeof readVerificationDocument>[0]) => {
          documentReads.push(file.fileId);
          return { type: "no-text" } as const;
        },
        generateObjectForRole: asTestRaw<typeof generateTanStackObjectForRole>(
          async (request: unknown) => {
            modelDispatches.push(request);
            return {};
          },
        ),
      };
      const control = await seedPinnedRun();
      await processListVerificationRun({
        data: { runId: control, organizationId, workspaceId, userId },
        admission: testModelAdmission(organizationId),
        actor: actorFor(control),
        execution,
      });
      expect(documentReads).toHaveLength(1);
      expect(await readRun(control)).toEqual({
        status: "failed",
        errorCode: "no_text",
      });
      documentReads.length = 0;
      const runId = await seedPinnedRun();
      const restore = await revokeExecutionPrerequisite(kind);
      try {
        const args = {
          data: { runId, organizationId, workspaceId, userId },
          admission: testModelAdmission(organizationId),
          actor: actorFor(runId),
          execution,
        };
        await processListVerificationRun(args);
        await processListVerificationRun(args);
        expect(documentReads).toHaveLength(0);
        expect(modelDispatches).toHaveLength(0);
        expect(await readRun(runId)).toEqual({
          status: "failed",
          errorCode: "access_revoked",
        });
        expect(await readAudits(runId)).toHaveLength(1);
        await assertActiveSlotReleased(runId);
      } finally {
        await restore();
      }
    }),
);

test.each(["matter", "grant", "deployment", "active"] as const)(
  "reconciliation closes queued and running %s removal once without requeueing",
  async (kind) =>
    await withProductionPrerequisites(async () => {
      const queued = await seedRun();
      const running = await seedRun("running");
      await db
        .update(legalListVerificationRuns)
        .set({ startedAt: new Date() })
        .where(eq(legalListVerificationRuns.id, running));
      const { queue, added } = queueFixture();
      const queueDb =
        asTestRaw<
          Parameters<typeof reconcileQueuedListVerificationRuns>[0]["db"]
        >(db);
      const restore = await revokeExecutionPrerequisite(kind);
      try {
        (
          await reconcileQueuedListVerificationRuns({ db: queueDb, queue })
        ).unwrap();
        await reconcileStuckListVerificationRuns(queueDb);
        (
          await reconcileQueuedListVerificationRuns({ db: queueDb, queue })
        ).unwrap();
        await reconcileStuckListVerificationRuns(queueDb);
        expect(added).toHaveLength(0);
        expect(await readRun(queued)).toEqual({
          status: "failed",
          errorCode: "access_revoked",
        });
        expect(await readRun(running)).toEqual({
          status: "failed",
          errorCode: "access_revoked",
        });
        expect(await readAudits(queued)).toHaveLength(1);
        expect(await readAudits(running)).toHaveLength(1);
        await assertActiveSlotReleased(queued);
        await assertActiveSlotReleased(running);
      } finally {
        await restore();
      }
    }),
);

test("granted duplicate delivery executes once using the persisted requester", async () => {
  const runId = await seedRun();
  let calls = 0;
  const actor = actorFor(runId);
  const execute = async () => {
    calls += 1;
    await actor.writeDb(
      async (tx) =>
        await failVerificationRun({
          tx,
          run: { id: runId, organizationId, workspaceId },
          errorCode: "internal",
        }),
    );
    return null;
  };
  const args = {
    data: { runId, organizationId, workspaceId, userId },
    admission: testModelAdmission(organizationId),
    actor,
    grants,
    execute,
  };
  await processListVerificationRun(args);
  await processListVerificationRun(args);
  expect(calls).toBe(1);
  expect(await readAudits(runId)).toHaveLength(1);
});

test("job requester mismatch leaves the persisted run unchanged", async () => {
  const runId = await seedRun();
  const actor = {
    ...actorFor(runId),
    userId: toSafeId<"user">("another-requester"),
  };
  let calls = 0;
  await processListVerificationRun({
    data: { runId, organizationId, workspaceId, userId: actor.userId },
    admission: testModelAdmission(organizationId),
    actor,
    grants,
    execute: async () => {
      calls += 1;
      return null;
    },
  });
  expect(calls).toBe(0);
  expect(await readRun(runId)).toEqual({ status: "queued", errorCode: null });
  expect(await readAudits(runId)).toHaveLength(0);
  await actorFor(runId).writeDb(
    async (tx) =>
      await failVerificationRun({
        tx,
        run: { id: runId, organizationId, workspaceId },
        errorCode: "internal",
      }),
  );
});

test("reconciliation audits timeout and requester removal exactly once", async () => {
  const timedOut = await seedRun("running");
  const requesterRemoved = await seedRun();
  await db
    .update(legalListVerificationRuns)
    .set({ requestedBy: null })
    .where(eq(legalListVerificationRuns.id, requesterRemoved));
  expect(
    await reconcileStuckListVerificationRuns(
      asTestRaw<Parameters<typeof reconcileStuckListVerificationRuns>[0]>(db),
      grants,
    ),
  ).toBe(2);
  expect(
    await reconcileStuckListVerificationRuns(
      asTestRaw<Parameters<typeof reconcileStuckListVerificationRuns>[0]>(db),
      grants,
    ),
  ).toBe(0);
  expect(await readRun(timedOut)).toEqual({
    status: "failed",
    errorCode: "internal",
  });
  expect(await readRun(requesterRemoved)).toEqual({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(await readAudits(timedOut)).toHaveLength(1);
  expect(await readAudits(requesterRemoved)).toHaveLength(1);
});

test("queue reconciliation admits grants and closes revoked matter access", async () => {
  const runId = await seedRun();
  const { queue, added } = queueFixture();
  const queueDb =
    asTestRaw<Parameters<typeof reconcileQueuedListVerificationRuns>[0]["db"]>(
      db,
    );
  (
    await reconcileQueuedListVerificationRuns({ db: queueDb, queue, grants })
  ).unwrap();
  (
    await reconcileQueuedListVerificationRuns({ db: queueDb, queue, grants })
  ).unwrap();
  expect(added).toHaveLength(1);
  await db
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.id, workspaceMemberId));
  (
    await reconcileQueuedListVerificationRuns({ db: queueDb, queue, grants })
  ).unwrap();
  expect(await readRun(runId)).toEqual({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(await readAudits(runId)).toHaveLength(1);
  await db
    .insert(workspaceMembers)
    .values({ id: workspaceMemberId, workspaceId, userId });
});

test("membership removal closes queued execution with a server-bound audit", async () => {
  const runId = await seedRun();
  await db.delete(member).where(eq(member.id, organizationMemberId));
  let calls = 0;
  await processListVerificationRun({
    data: { runId, organizationId, workspaceId, userId },
    admission: testModelAdmission(organizationId),
    actor: actorFor(runId),
    grants,
    execute: async () => {
      calls += 1;
      return null;
    },
  });
  expect(calls).toBe(0);
  expect(await readRun(runId)).toEqual({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(await readAudits(runId)).toEqual([
    {
      userId,
      metadata: {
        runId,
        status: "failed",
        errorCode: "access_revoked",
        blockCount: 0,
        claimCount: 0,
      },
    },
  ]);
  await db.insert(member).values({
    id: organizationMemberId,
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  await db
    .insert(workspaceMembers)
    .values({ id: workspaceMemberId, workspaceId, userId });
});

test("current role permission is required for queued execution", async () => {
  const runId = await seedRun();
  await db
    .update(member)
    .set({ role: "intern" })
    .where(eq(member.id, organizationMemberId));
  let calls = 0;
  await processListVerificationRun({
    data: { runId, organizationId, workspaceId, userId },
    admission: testModelAdmission(organizationId),
    actor: actorFor(runId),
    grants,
    execute: async () => {
      calls += 1;
      return null;
    },
  });
  expect(calls).toBe(0);
  expect(await readRun(runId)).toEqual({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(await readAudits(runId)).toHaveLength(1);
  await db
    .update(member)
    .set({ role: "member" })
    .where(eq(member.id, organizationMemberId));
});

test.each([
  "grant",
  "membership",
  "matter",
  "permission",
  "requester",
] as const)(
  "running %s revocation stops the next model request and audits once",
  async (revoke) =>
    await withProductionPrerequisites(async () => {
      const runId = await seedRun();
      let calls = 0;
      let currentGrants: FeatureAccessGrants = grants;
      expect(
        await db
          .select({ role: member.role })
          .from(member)
          .where(eq(member.id, organizationMemberId)),
      ).toEqual([{ role: "member" }]);
      expect(
        await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.id, workspaceMemberId)),
      ).toEqual([{ id: workspaceMemberId }]);
      await processListVerificationRun({
        data: { runId, organizationId, workspaceId, userId },
        admission: testModelAdmission(organizationId),
        actor: actorFor(runId),
        grants,
        execute: async ({ actor, admission, accessProof }) => {
          const call = createVerificationCall({
            deps: {
              admission,
              accessProof,
              refreshAccessProof: async () => {
                const decision = await actor.writeDb(
                  async (tx) =>
                    await resolveListVerificationRunAccess({
                      tx,
                      run: { id: runId, organizationId, workspaceId },
                      requesterId: userId,
                      expectedStatus: "running",
                      grants: currentGrants,
                    }),
                );
                return decision.status === "available" ? decision.proof : null;
              },
              organizationId,
              workspaceId,
              entityVersionId: createSafeId<"entityVersion">(),
              orgAIConfig: null,
              managedAIResidency: "eu",
              promptCachingEnabled: false,
              serviceTier: "standard",
              usageMetering: {
                actionType: "doc_review",
                organizationId,
                workspaceId,
                userId,
                safeDb: actor.writeSafeDb,
                serviceTier: "standard",
              },
              abortSignal: AbortSignal.timeout(5000),
              generateObjectForRole: asTestRaw<
                typeof generateTanStackObjectForRole
              >(async () => {
                calls += 1;
                return { value: "fixture" };
              }),
            },
            feature: "verification-test",
            system: "Fixture instruction",
            shared: null,
            outputSchema: v.object({ value: v.string() }),
          });
          expect(await call.generate([])).toEqual(
            Result.ok({ value: "fixture" }),
          );
          switch (revoke) {
            case "grant":
              currentGrants = {};
              break;
            case "membership":
              await db
                .delete(member)
                .where(eq(member.id, organizationMemberId));
              break;
            case "matter":
              await db
                .delete(workspaceMembers)
                .where(eq(workspaceMembers.id, workspaceMemberId));
              break;
            case "permission":
              await db
                .update(member)
                .set({ role: "intern" })
                .where(eq(member.id, organizationMemberId));
              break;
            case "requester":
              await db
                .update(legalListVerificationRuns)
                .set({ requestedBy: null })
                .where(eq(legalListVerificationRuns.id, runId));
              break;
            default:
              revoke satisfies never;
          }
          const denied = await call.generate([]);
          expect(Result.isError(denied) ? denied.error : null).toBeInstanceOf(
            ListVerificationAccessRevokedError,
          );
          return "access_revoked";
        },
      });
      expect(calls).toBe(1);
      expect(await readRun(runId)).toEqual({
        status: "failed",
        errorCode: "access_revoked",
      });
      expect(await readAudits(runId)).toHaveLength(1);
      await processListVerificationRun({
        data: { runId, organizationId, workspaceId, userId },
        admission: testModelAdmission(organizationId),
        actor: actorFor(runId),
        grants,
        execute: async () => {
          calls += 1;
          return null;
        },
      });
      expect(calls).toBe(1);
      expect(await readAudits(runId)).toHaveLength(1);
      if (revoke === "membership") {
        await db.insert(member).values({
          id: organizationMemberId,
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        await db
          .insert(workspaceMembers)
          .values({ id: workspaceMemberId, workspaceId, userId });
      }
      if (revoke === "matter") {
        await db
          .insert(workspaceMembers)
          .values({ id: workspaceMemberId, workspaceId, userId });
      }
      if (revoke === "permission") {
        await db
          .update(member)
          .set({ role: "member" })
          .where(eq(member.id, organizationMemberId));
      }
    }),
);

test("queue handoff failures surface while the persisted run remains recoverable", async () =>
  await withProductionPrerequisites(async () => {
    const runId = await seedRun();
    const healthy = queueFixture();
    const queueDb =
      asTestRaw<
        Parameters<typeof reconcileQueuedListVerificationRuns>[0]["db"]
      >(db);
    const failed = await reconcileQueuedListVerificationRuns({
      db: queueDb,
      grants,
      queue: {
        ...healthy.queue,
        add: async () => {
          throw new Error("Fixture queue unavailable");
        },
      },
    });
    expect(failed.isErr()).toBe(true);
    if (failed.isErr()) {
      expect(failed.error.message).toBe(
        "List verification reconciliation failed",
      );
    }
    expect(await readRun(runId)).toEqual({ status: "queued", errorCode: null });
    const recovered = await reconcileQueuedListVerificationRuns({
      db: queueDb,
      grants,
      queue: healthy.queue,
    });
    expect(recovered.isOk()).toBe(true);
    expect(healthy.added).toHaveLength(1);
  }));
