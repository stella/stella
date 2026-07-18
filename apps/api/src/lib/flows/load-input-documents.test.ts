/**
 * An `ai` step with `includeDocuments` must not silently proceed when a selected
 * input has no extracted content (extraction pending/failed, or a non-extraction
 * entity surfaced by the summaries picker). Producing legal output from an
 * incomplete document set is not acceptable, so the step fails and names the
 * unavailable inputs. Driven against a real (PGlite) database under RLS.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";

import { organization, user } from "@/api/db/auth-schema";
import { entities, extractedContent, workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();

// flow-executor imports the queue/AI/S3 boundaries at module load; stub them so
// importing it does not reach Redis or external services.
void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));
void mock.module("@/api/lib/flows/flow-run-queue", () => ({
  FLOW_RUN_QUEUE_NAME: "flow-run",
  enqueueFlowStep: mock(async () => {}),
}));
void mock.module("@/api/lib/flows/flow-run-events", () => ({
  broadcastFlowRunUpdate: mock(() => undefined),
}));
void mock.module("@/api/lib/tanstack-ai-generate", () => ({
  generateTanStackTextForRole: mock(async () => await Promise.resolve("")),
}));
void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ write: mock(async () => {}), delete: mock(async () => {}) }),
}));
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: mock(async () => {}),
}));
void mock.module("@/api/lib/file-derivative-queue", () => ({
  enqueueImageThumbnail: mock(async () => {}),
  enqueueImageThumbnailOrMarkFailed: mock(async () => {}),
  enqueuePdfDerivative: mock(async () => {}),
  enqueuePdfDerivativeOrMarkFailed: mock(async () => {}),
  initFileDerivativeWorker: mock(() => undefined),
}));

const { loadInputDocuments, FlowStepError } =
  await import("@/api/lib/flows/flow-executor");

describe("loadInputDocuments", () => {
  const organizationId = createSafeId<"organization">();
  const userId = createSafeId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const extractedEntityId = createSafeId<"entity">();
  const pendingEntityId = createSafeId<"entity">();

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Docs Org",
      slug: `docs-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: userId,
      name: "Docs User",
      email: `${userId}@test.local`,
    });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Docs matter",
      reference: "DOCS",
    });
    await testDb.insert(entities).values([
      {
        id: extractedEntityId,
        workspaceId,
        name: "Available doc",
        createdByUserId: userId,
      },
      {
        id: pendingEntityId,
        workspaceId,
        name: "Pending doc",
        createdByUserId: userId,
      },
    ]);
    // Only the first entity has extracted content; the second is still pending.
    await testDb.insert(extractedContent).values({
      entityId: extractedEntityId,
      organizationId,
      workspaceId,
      ciphertext: Buffer.from([1, 2, 3]),
      iv: Buffer.from([4, 5, 6]),
      charCount: 3,
    });
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const scopedDb = () =>
    asTestRaw<Parameters<typeof loadInputDocuments>[0]>(
      createScopedDb(testDb, [workspaceId], organizationId, userId),
    );

  test("fails the step and names inputs whose content is unavailable", async () => {
    const caught = await loadInputDocuments(scopedDb(), organizationId, [
      extractedEntityId,
      pendingEntityId,
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(FlowStepError);
    if (caught instanceof FlowStepError) {
      expect(caught.message).toContain("Pending doc");
    }
  });
});
