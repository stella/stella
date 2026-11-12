import { describe, expect, test } from "bun:test";

import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import deleteTask from "./delete";

type DeleteTaskCtx = Parameters<typeof deleteTask.handler>[0];

describe("deleting a task", () => {
  test("anything but a task in the matter is not found, and nothing is deleted", async () => {
    const workspaceId = createSafeId<"workspace">();
    const taskId = createSafeId<"entity">();
    let lookedUp: unknown;
    let deleted = false;
    const { safeDb, scopedDb } = createScopedDbMock(
      {
        query: {
          entities: {
            // The id names an item the caller can see that is not a task in
            // this matter, such as a document: the lookup, which asks for a
            // task in this matter, finds nothing.
            findFirst: async (input: unknown): Promise<null> => {
              lookedUp = input;
              return await Promise.resolve(null);
            },
          },
        },
        delete: () => {
          deleted = true;
          throw new Error("nothing may be deleted");
        },
      },
      { visibleResources: { entity: [taskId] } },
    );

    const result = await deleteTask.handler(
      asTestRaw<DeleteTaskCtx>({
        params: { taskId },
        request: new Request(
          `https://example.test/v1/tasks/${workspaceId}/${taskId}`,
          { method: "DELETE" },
        ),
        route: "/v1/tasks/:workspaceId/:taskId" satisfies ApiRoutePath,
        safeDb,
        scopedDb,
        workspaceId,
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: toSafeId<"organization">("org_1") },
        user: { id: toSafeId<"user">("user_1") },
        recordAuditEvent: async () => {},
      }),
    );

    expect(result).toMatchObject({
      code: 404,
      response: { code: "not_found", message: "Task not found" },
    });
    expect(lookedUp).toMatchObject({
      where: {
        id: { eq: taskId },
        workspaceId: { eq: workspaceId },
        kind: { eq: "task" },
      },
    });
    expect(deleted).toBe(false);
  });
});
