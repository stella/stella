/**
 * Authorization gate for automated flow runs: an automated run (schedule /
 * file-upload trigger) executes as the definition's author against a root-scoped
 * grant for its workspace, so the start path is the only place that can enforce
 * the author's access to that matter. A file-upload trigger saved with
 * `workspaceIds: null` ("all matters") matches uploads in every matter,
 * including ones the author is not a member of, so the gate must refuse to start
 * there. Driven against a real (PGlite) database so the real
 * `resolveMemberAuthorization` membership rule runs.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  flowDefinitions,
  flowRuns,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { FlowStep, FlowTrigger } from "@/api/lib/flows/flow-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testDb: TestDatabase = await getTestDb();

void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));

type EnqueuedStep = { runId: string; stepIndex: number };
const enqueuedSteps: EnqueuedStep[] = [];
void mock.module("@/api/lib/flows/flow-run-queue", () => ({
  FLOW_RUN_QUEUE_NAME: "flow-run",
  enqueueFlowStep: mock(
    async ({ runId, stepIndex }: EnqueuedStep & { delayMs?: number }) => {
      enqueuedSteps.push({ runId, stepIndex });
    },
  ),
}));

void mock.module("@/api/lib/flows/flow-run-events", () => ({
  broadcastFlowRunUpdate: mock(() => undefined),
}));

const { startAutomatedFlowRun } =
  await import("@/api/lib/flows/start-automated-flow-run");

const AI_STEP: FlowStep = {
  kind: "ai",
  name: "Draft memo",
  prompt: "Draft a short legal memo.",
  includeDocuments: false,
};

// A wildcard file-upload trigger: matches uploads in every matter of the org.
const WILDCARD_UPLOAD_TRIGGER = {
  type: "file-upload",
  workspaceIds: null,
  fileExtensions: null,
} as const satisfies FlowTrigger;

describe("startAutomatedFlowRun authorization gate", () => {
  const organizationId = createSafeId<"organization">();
  const authorId = createSafeId<"user">();
  // The author is a member of this matter and a stranger to the other.
  const authorizedWorkspaceId = createSafeId<"workspace">();
  const unauthorizedWorkspaceId = createSafeId<"workspace">();
  const definitionId = createSafeId<"flowDefinition">();
  const entityId = createSafeId<"entity">();

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Automated Run Authz Org",
      slug: `automated-authz-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: authorId,
      name: "Flow Author",
      email: `${authorId}@test.local`,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: authorId,
      role: "member",
      createdAt: new Date(),
    });
    await testDb.insert(workspaces).values([
      {
        id: authorizedWorkspaceId,
        organizationId,
        clientId: null,
        name: "Author matter",
        reference: "AUTHZ-OK",
      },
      {
        id: unauthorizedWorkspaceId,
        organizationId,
        clientId: null,
        name: "Restricted matter",
        reference: "AUTHZ-NO",
      },
    ]);
    await testDb.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId: authorizedWorkspaceId,
      userId: authorId,
    });
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Wildcard upload flow",
      steps: [AI_STEP],
      trigger: WILDCARD_UPLOAD_TRIGGER,
      enabled: true,
      createdByUserId: authorId,
    });
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const runsForWorkspace = async (workspaceId: SafeId<"workspace">) =>
    await testDb
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(eq(flowRuns.workspaceId, workspaceId));

  const startForWorkspace = async (workspaceId: SafeId<"workspace">) => {
    await startAutomatedFlowRun({
      definitionId,
      organizationId,
      workspaceId,
      createdByUserId: authorId,
      triggerSource: { type: "file-upload", entityId },
      inputEntityIds: [entityId],
      logContext: { definitionId, workspaceId, trigger: "file-upload" },
    });
  };

  test("starts the run when the author can access the upload workspace", async () => {
    await startForWorkspace(authorizedWorkspaceId);

    expect(await runsForWorkspace(authorizedWorkspaceId)).toHaveLength(1);
    expect(enqueuedSteps.some((step) => step.stepIndex === 0)).toBe(true);
  });

  test("skips the run when the wildcard trigger fires in a matter the author cannot access", async () => {
    const enqueuedBefore = enqueuedSteps.length;

    await startForWorkspace(unauthorizedWorkspaceId);

    expect(await runsForWorkspace(unauthorizedWorkspaceId)).toHaveLength(0);
    expect(enqueuedSteps).toHaveLength(enqueuedBefore);
  });
});
