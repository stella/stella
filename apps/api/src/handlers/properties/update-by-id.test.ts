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
  recordAuditEvent = async () => {},
}: {
  body: UpdatePropertyCtx["body"];
  safeDb: UpdatePropertyCtx["safeDb"];
  scopedDb: UpdatePropertyCtx["scopedDb"];
  recordAuditEvent?: UpdatePropertyCtx["recordAuditEvent"];
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
    recordAuditEvent,
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

  test("preserves dependency gates when renaming a playbook-materialized manual column", async () => {
    const gateRow = {
      dependsOnPropertyId: toSafeId<"property">("classifier_prop"),
      condition: {
        type: "compare",
        left: { type: "property", propertyId: toSafeId("classifier_prop") },
        op: "eq",
        right: { type: "literal", value: "NDA" },
      },
    };
    const oldDependencies = [gateRow];

    let deleteCalled = false;
    let auditedDependencies: unknown;

    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                id: toSafeId<"property">("property_test"),
                name: "Old name",
                content: { version: 1, type: "text" },
                tool: { version: 1, type: "manual-input" },
                status: "fresh",
                playbookDefinitionId:
                  toSafeId<"playbookDefinition">("pb_def_test"),
              },
            ],
          }),
        }),
      }),
      query: {
        propertyDependencies: { findMany: async () => oldDependencies },
      },
      update: () => ({
        set: () => ({ where: async () => undefined }),
      }),
      delete: () => {
        deleteCalled = true;
        return { where: async () => undefined };
      },
    });

    const result = await updateProperty.handler(
      createContext({
        safeDb,
        scopedDb,
        recordAuditEvent: async (_tx, event) => {
          auditedDependencies = event.changes?.dependencies;
        },
        body: {
          name: "New name",
          content: { version: 1, type: "text" },
          tool: { version: 1, type: "manual-input" },
        },
      }),
    );

    expect(result).toEqual({});
    expect(deleteCalled).toBe(false);
    expect(auditedDependencies).toEqual({
      old: oldDependencies,
      new: oldDependencies,
    });
  });
});
