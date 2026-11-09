/**
 * A fact extraction resolves its pinned documents under its requester's
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
  type Mock,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  legalListGenerationRuns,
  legalListGenerationSources,
  legalLists,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { processFactExtractionRun } from "@/api/lib/lists/generation/run-queue";
import * as documentText from "@/api/lib/lists/verification/document-text";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedLegalListGenerationRunId } from "@/api/lib/safe-id-boundaries";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

// timeout: the first test builds the shared PGlite fixture.
setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const testState = createTestState({ file: import.meta.path, config: env });
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
  panic("Fact extraction run fixture is incomplete");
}

const listId = createSafeId<"legalList">();
const runId = createSafeId<"legalListGenerationRun">();
const actor = createRootRunActor(
  {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    runId,
  },
  brandPersistedLegalListGenerationRunId,
  database,
);
const data = {
  runId,
  organizationId: ids.orgA,
  workspaceId: ids.wsA1,
  userId: ids.userA1,
};

let readSpy: Mock<typeof documentText.readVerificationDocument>;

const readRun = async () =>
  (
    await testDb
      .select({
        status: legalListGenerationRuns.status,
        errorCode: legalListGenerationRuns.errorCode,
        completedAt: legalListGenerationRuns.completedAt,
      })
      .from(legalListGenerationRuns)
      .where(eq(legalListGenerationRuns.id, runId))
      .limit(1)
  ).at(0);

beforeEach(async () => {
  readSpy = spyOn(documentText, "readVerificationDocument");
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
    "list-verification": [{ type: "organization", organizationId: ids.orgA }],
  });
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  readSpy.mockReset();
  readSpy.mockImplementation(async () => ({ type: "no-text" }));
  await testDb.insert(legalLists).values({
    id: listId,
    workspaceId: ids.wsA1,
    name: "Chronology",
    createdBy: ids.userA1,
  });
  await testDb.insert(legalListGenerationRuns).values({
    id: runId,
    workspaceId: ids.wsA1,
    listId,
    organizationId: ids.orgA,
    producer: "stella",
    itemType: "fact",
    status: "queued",
    instruction: "List every fact the documents establish.",
    requestedBy: ids.userA1,
  });
  await testDb.insert(legalListGenerationSources).values({
    id: createSafeId<"legalListGenerationSource">(),
    workspaceId: ids.wsA1,
    listId,
    runId,
    sourceEntityId: ids.entityA1,
    sourceEntityVersionId: ids.entityVersionA1,
  });
});

afterEach(async () => {
  mock.restore();
  // Deleting the list cascades its runs and their sources.
  await testDb.delete(legalLists).where(eq(legalLists.id, listId));
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
  readSpy.mockRestore();
  await releaseRlsFixture();
});

const expectStoppedBeforeReading = async () => {
  await processFactExtractionRun({
    actor,
    admission: testModelAdmission(actor.organizationId),
    data,
  });
  const run = await readRun();
  expect(run).toMatchObject({ status: "failed", errorCode: "access_revoked" });
  expect(run?.completedAt).not.toBeNull();
  expect(readSpy).not.toHaveBeenCalled();
};

describe("fact extraction run", () => {
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
    await processFactExtractionRun({
      actor,
      admission: testModelAdmission(actor.organizationId),
      data,
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
