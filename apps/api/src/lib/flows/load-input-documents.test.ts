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
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();

// flow-executor imports the queue/AI/S3 boundaries at module load; stub the
// queue and AI ones so importing it does not reach Redis or external
// services. Object storage is the real `lib/s3` instead, pointed at an
// in-process store (see the fake below), so the suite can assert that this
// path reaches no object at all rather than trusting a stub to say so.
void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));
void mock.module("@/api/lib/flows/flow-run-queue", () => ({
  FLOW_RUN_QUEUE_NAME: "flow-run",
  enqueueFlowStep: mock(async () => {}),
}));
const realFlowRunEvents = await import("@/api/lib/flows/flow-run-events");
void mock.module("@/api/lib/flows/flow-run-events", () => ({
  ...realFlowRunEvents,
  broadcastFlowRunUpdate: mock(() => undefined),
}));
void mock.module("@/api/lib/tanstack-ai-generate", () => ({
  generateTanStackTextForRole: mock(async () => await Promise.resolve("")),
}));
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: mock(async () => {}),
  requestNativeExtractionRun: mock(async () => null),
}));
const realFileDerivativeQueue = await import("@/api/lib/file-derivative-queue");
void mock.module("@/api/lib/file-derivative-queue", () => ({
  ...realFileDerivativeQueue,
  enqueueImageThumbnail: mock(async () => {}),
  enqueueImageThumbnailOrMarkFailed: mock(async () => {}),
  enqueuePdfDerivative: mock(async () => {}),
  enqueuePdfDerivativeOrMarkFailed: mock(async () => {}),
  initFileDerivativeWorker: mock(() => undefined),
}));

const { loadInputDocuments, FlowStepError } =
  await import("@/api/lib/flows/flow-executor");

describe("loadInputDocuments", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const extractedEntityId = createSafeId<"entity">();
  const pendingEntityId = createSafeId<"entity">();
  let fake: FakeS3;

  beforeAll(async () => {
    fake = startFakeS3();
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
        createdBy: userId,
      },
      {
        id: pendingEntityId,
        workspaceId,
        name: "Pending doc",
        createdBy: userId,
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
    fake.stop();
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
    // The unavailable input is detected from the database alone. Reading any
    // object before that check would spend a request per input on a step that
    // cannot run, and would surface a store outage as a document failure.
    expect(fake.requests).toEqual([]);
  });
});
