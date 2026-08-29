import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { WORKFLOW_START_STATUSES } from "@/api/lib/workflow-queue";
import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createWorkflowStart } from "./workflow-start";

const startWorkflowMock = mock();

const workflowStart = createWorkflowStart({ startWorkflow: startWorkflowMock });

type WorkflowStartCtx = Parameters<typeof workflowStart.handler>[0];

const organizationId = toSafeId<"organization">("org_test");
const userId = toSafeId<"user">("user_test");
const workspaceId = toSafeId<"workspace">("workspace_test");
const entityId = toSafeId<"entity">("entity_test");
const propertyId = toSafeId<"property">("property_test");

const body = {
  entityIds: [entityId],
  entityIdsOrder: [entityId],
  propertyIds: [propertyId],
  serviceTier: "standard" as const,
};

const { scopedDb, safeDb } = createScopedDbMock({});

const startWorkspaceWorkflow = async () =>
  await workflowStart.handler(
    createTestHandlerContext<WorkflowStartCtx>({
      body,
      safeDb,
      scopedDb,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      workspaceId,
    }),
  );

describe("workflow start handler", () => {
  beforeEach(() => {
    startWorkflowMock.mockReset();
    startWorkflowMock.mockResolvedValue({ status: "started" });
  });

  test("threads workspace identity and explicit target filters into the workflow queue", async () => {
    const result = await startWorkspaceWorkflow();

    expect(result).toEqual({ status: "started" });
    expect(startWorkflowMock).toHaveBeenCalledWith({
      workspaceId,
      organizationId,
      userId,
      scopedDb,
      entityIds: [entityId],
      entityIdsOrder: [entityId],
      propertyIds: [propertyId],
      serviceTier: "standard",
    });
  });

  test("a failed enqueue is answered as an error status, never as a started workflow", async () => {
    // Exercises the whole status set the queue can answer, so a new status
    // cannot reach the wire without this test recording which side it took:
    // clients read any 2xx as "the extraction is running".
    // Sequential by construction: one shared queue mock answers one status per
    // call.
    const outcomes = await Array.fromAsync(
      WORKFLOW_START_STATUSES,
      async (status) => {
        startWorkflowMock.mockResolvedValue({ status });
        return { status, result: await startWorkspaceWorkflow() };
      },
    );

    const rejected: WorkflowStartStatus[] = [];
    for (const { status, result } of outcomes) {
      if ("code" in result) {
        expect(result.code).toBe(500);
        rejected.push(status);
        continue;
      }
      // Asserted from the queue's side: the success body's status type no
      // longer admits `failed`, so it cannot be compared against the raw union.
      expect(status).toBe(result.status);
    }

    expect(rejected).toEqual(["failed"]);
    // Declared set equals exercised set: every status the queue can answer
    // went through the handler above.
    expect(outcomes.map(({ status }) => status)).toEqual([
      ...WORKFLOW_START_STATUSES,
    ]);
  });
});
