/**
 * A list verification resolves its pinned document under its requester's
 * current access, so nothing from a matter the requester can no longer open
 * is read. Driven against a real (PGlite) database; the document reader is a
 * fake that reports no text, which ends the run before any model call.
 */

import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { legalListVerificationRuns, workspaceMembers } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import * as documentText from "@/api/lib/lists/verification/document-text";
import { processListVerificationRun } from "@/api/lib/lists/verification/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const previousGrants = env.API_FEATURE_ACCESS_GRANTS;
const previousDeployment = env.FEATURE_LEGAL_LISTS;
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);

const originalOrganizationMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
// Leaving the organization also ends every matter membership in it, so the
// restore covers all of them, not only the one a test removes directly.
const originalMatterMembers = await testDb.query.workspaceMembers.findMany({
  where: {
    userId: { eq: ids.userA1 },
    workspaceId: { in: [ids.wsA1, ids.wsA2] },
  },
});
if (!originalOrganizationMember || originalMatterMembers.length === 0) {
  panic("Verification run fixture is incomplete");
}

const runId = createSafeId<"legalListVerificationRun">();
const actor = createRootRunActor(
  {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    runId,
  },
  brandPersistedListVerificationRunId,
  database,
);

const readSpy = spyOn(documentText, "readVerificationDocument");

const readRun = async () =>
  (
    await testDb
      .select()
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.id, runId))
      .limit(1)
  ).at(0);

beforeEach(async () => {
  env.FEATURE_LEGAL_LISTS = true;
  env.API_FEATURE_ACCESS_GRANTS = {
    "list-verification": [{ type: "organization", organizationId: ids.orgA }],
  };
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  readSpy.mockReset();
  readSpy.mockImplementation(async () => ({ type: "no-text" }));
  await testDb.insert(legalListVerificationRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: ids.fileFieldA1,
    entityVersionId: ids.entityVersionA1,
    // The fixture's file field content hash.
    contentSha256: "a".repeat(64),
    evidence: {
      listId: toSafeId<"legalList">(Bun.randomUUIDv7()),
      facts: [],
    },
    status: "queued",
    requestedBy: ids.userA1,
    pipelineVersion: 2,
  });
});

afterEach(async () => {
  await testDb
    .delete(legalListVerificationRuns)
    .where(eq(legalListVerificationRuns.id, runId));
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMembers)
    .onConflictDoNothing();
});

afterAll(async () => {
  env.API_FEATURE_ACCESS_GRANTS = previousGrants;
  env.FEATURE_LEGAL_LISTS = previousDeployment;
  readSpy.mockRestore();
  await releaseRlsFixture();
});

const expectStoppedBeforeReading = async () => {
  await processListVerificationRun({
    actor,
    admission: testModelAdmission(actor.organizationId),
    data: {
      runId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    },
  });
  const run = await readRun();
  expect(run).toMatchObject({ status: "failed", errorCode: "access_revoked" });
  expect(run?.finishedAt).not.toBeNull();
  expect(readSpy).not.toHaveBeenCalled();
};

describe("list verification run", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));
    await expectStoppedBeforeReading();
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    await expectStoppedBeforeReading();
  });

  test("a run reads its pinned document while its requester keeps access", async () => {
    await processListVerificationRun({
      actor,
      admission: testModelAdmission(actor.organizationId),
      data: {
        runId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
      },
    });
    expect(await readRun()).toMatchObject({
      status: "failed",
      errorCode: "no_text",
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls.at(0)?.at(0)).toMatchObject({
      file: { fileId: ids.fileObjectA1 },
    });
  });
});
