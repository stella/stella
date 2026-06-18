import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateProperty from "./update-by-id";

type UpdatePropertyCtx = Parameters<typeof updateProperty.handler>[0];

const createContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: UpdatePropertyCtx["body"];
  safeDb: UpdatePropertyCtx["safeDb"];
  scopedDb: UpdatePropertyCtx["scopedDb"];
}): UpdatePropertyCtx =>
  asTestRaw<UpdatePropertyCtx>({
    body,
    safeDb,
    scopedDb,
    params: { propertyId: toSafeId<"property">("property_test") },
    workspaceId: toSafeId<"workspace">("workspace_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent: async () => {},
  });

describe("updateProperty", () => {
  test("rejects a select fallback outside the supplied options", async () => {
    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({});

    const result = await updateProperty.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          name: "Decision",
          content: {
            version: 1,
            type: "single-select",
            options: [
              { value: "Yes", color: "green" },
              { value: "No", color: "red" },
            ],
            fallback: "Maybe",
          },
          tool: { version: 1, type: "manual-input" },
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Fallback must match one of the supplied options" },
    });
    expect(getCallCount()).toBe(0);
  });
});
