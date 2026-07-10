import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const startWorkflowMock = mock(async () => ({ status: "started" as const }));

void mock.module("@/api/lib/workflow-queue", () => ({
  startWorkflow: startWorkflowMock,
}));

const { default: workflowStart } = await import("./workflow-start");

type WorkflowStartCtx = Parameters<typeof workflowStart.handler>[0];

const organizationId = toSafeId<"organization">("org_test");
const userId = toSafeId<"user">("user_test");
const workspaceId = toSafeId<"workspace">("ws_test");
const entityId = toSafeId<"entity">("entity_test");
const propertyId = toSafeId<"property">("property_test");

describe("workflow start handler", () => {
  test("threads workspace identity and explicit target filters into the workflow queue", async () => {
    const { scopedDb, safeDb } = createScopedDbMock({});
    const body = {
      entityIds: [entityId],
      entityIdsOrder: [entityId],
      propertyIds: [propertyId],
      serviceTier: "standard" as const,
    };

    const result = await workflowStart.handler(
      asTestRaw<WorkflowStartCtx>({
        getActiveWorkspaceIds: async () => [workspaceId],
        getAccessibleWorkspaces: async () => [
          { id: workspaceId, status: "active" },
        ],
        getWorkspaceAccess: async () => ({
          id: workspaceId,
          status: "active",
        }),
        body,
        createAuditRecorder: () => async () => undefined,
        memberRole: { role: "owner" },
        orgAIConfig: null,
        promptCachingEnabled: false,
        recordAuditEvent: async () => undefined,
        request: new Request(`https://example.test/workspaces/${workspaceId}`),
        route: "/test/workflow-start",
        safeDb,
        scopedDb,
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        workspaceId,
      }),
    );

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
});
