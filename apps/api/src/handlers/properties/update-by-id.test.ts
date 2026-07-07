import { describe, expect, test } from "bun:test";

import { DOCUMENT_TYPE_CLASSIFIER_ROLE } from "@/api/handlers/properties/create-schema";
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

    let lockCallCount = 0;
    const { safeDb, scopedDb } = createScopedDbMock({
      execute: () => {
        lockCallCount++;
        return Promise.resolve(undefined);
      },
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
          const single = Array.isArray(event) ? event.at(0) : event;
          auditedDependencies = single?.changes?.["dependencies"];
        },
        body: {
          name: "New name",
          content: { version: 1, type: "text" },
          tool: { version: 1, type: "manual-input" },
        },
      }),
    );

    expect(result).toEqual({});
    expect(lockCallCount).toBe(1);
    expect(deleteCalled).toBe(false);
    expect(auditedDependencies).toEqual({
      old: oldDependencies,
      new: oldDependencies,
    });
  });

  test("rejects updates that would create a second document type classifier", async () => {
    let updateCalled = false;
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                id: toSafeId<"property">("property_test"),
                name: "Ordinary",
                content: { version: 1, type: "text" },
                tool: { version: 1, type: "manual-input" },
                role: null,
                status: "fresh",
                playbookDefinitionId: null,
              },
            ],
          }),
        }),
      }),
      query: {
        propertyDependencies: { findMany: async () => [] },
        properties: {
          findMany: async () => [
            {
              id: toSafeId<"property">("property_test"),
              name: "Document Type",
              content: {
                version: 1,
                type: "single-select",
                options: [{ value: "NDA", color: "blue" }],
                fallback: null,
              },
              tool: { version: 1, type: "ai-model", prompt: "classify" },
              role: null,
              dependencies: [],
            },
            {
              id: toSafeId<"property">("property_existing"),
              name: "Type de document",
              content: {
                version: 1,
                type: "single-select",
                options: [{ value: "MSA", color: "green" }],
                fallback: null,
              },
              tool: { version: 1, type: "ai-model", prompt: "classify" },
              role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
              dependencies: [],
            },
          ],
        },
      },
      update: () => {
        updateCalled = true;
        return { set: () => ({ where: async () => undefined }) };
      },
    });

    const result = await updateProperty.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          name: "Document Type",
          content: {
            version: 1,
            type: "single-select",
            options: [{ value: "NDA", color: "blue" }],
            fallback: null,
          },
          tool: {
            version: 1,
            type: "ai-model",
            prompt: "classify",
            dependencies: [],
          },
        },
      }),
    );

    expect(result).toEqual({
      code: 422,
      response: { message: "Document type classifier already exists" },
    });
    expect(updateCalled).toBe(false);
  });

  test("clears the classifier role when the updated shape no longer matches", async () => {
    let updatePatch: unknown;
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                id: toSafeId<"property">("property_test"),
                name: "Type de document",
                content: {
                  version: 1,
                  type: "single-select",
                  options: [{ value: "NDA", color: "blue" }],
                  fallback: null,
                },
                tool: { version: 1, type: "ai-model", prompt: "classify" },
                role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
                status: "fresh",
                playbookDefinitionId: null,
              },
            ],
          }),
        }),
      }),
      query: {
        propertyDependencies: { findMany: async () => [] },
        properties: {
          findMany: async () => [
            {
              id: toSafeId<"property">("property_test"),
              name: "Type de document",
              content: {
                version: 1,
                type: "single-select",
                options: [{ value: "NDA", color: "blue" }],
                fallback: null,
              },
              tool: { version: 1, type: "ai-model", prompt: "classify" },
              role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
              dependencies: [],
            },
          ],
        },
      },
      update: () => ({
        set: (patch: unknown) => {
          updatePatch = patch;
          return { where: async () => undefined };
        },
      }),
      delete: () => ({ where: async () => undefined }),
    });

    const result = await updateProperty.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          name: "Type de document",
          content: { version: 1, type: "text" },
          tool: { version: 1, type: "manual-input" },
        },
      }),
    );

    expect(result).toEqual({});
    expect(updatePatch).toMatchObject({ role: null });
  });

  test("allows edits to a tagged classifier when legacy duplicates remain", async () => {
    let updatePatch: unknown;
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                id: toSafeId<"property">("property_test"),
                name: "Type de document",
                content: {
                  version: 1,
                  type: "single-select",
                  options: [{ value: "NDA", color: "blue" }],
                  fallback: null,
                },
                tool: { version: 1, type: "ai-model", prompt: "classify" },
                role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
                status: "fresh",
                playbookDefinitionId: null,
              },
            ],
          }),
        }),
      }),
      query: {
        propertyDependencies: { findMany: async () => [] },
        properties: {
          findMany: async () => [
            {
              id: toSafeId<"property">("property_test"),
              name: "Type de document",
              content: {
                version: 1,
                type: "single-select",
                options: [{ value: "NDA", color: "blue" }],
                fallback: null,
              },
              tool: { version: 1, type: "ai-model", prompt: "classify" },
              role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
              dependencies: [],
            },
            {
              id: toSafeId<"property">("property_legacy"),
              name: "Document Type",
              content: {
                version: 1,
                type: "single-select",
                options: [{ value: "MSA", color: "green" }],
                fallback: null,
              },
              tool: { version: 1, type: "ai-model", prompt: "classify" },
              role: null,
              dependencies: [],
            },
          ],
        },
      },
      update: () => ({
        set: (patch: unknown) => {
          updatePatch = patch;
          return { where: async () => undefined };
        },
      }),
      delete: () => ({ where: async () => undefined }),
    });

    const result = await updateProperty.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          name: "Type de document",
          content: {
            version: 1,
            type: "single-select",
            options: [{ value: "NDA", color: "blue" }],
            fallback: null,
          },
          tool: {
            version: 1,
            type: "ai-model",
            prompt: "updated classifier",
            dependencies: [],
          },
        },
      }),
    );

    expect(result).toEqual({});
    expect(updatePatch).toMatchObject({ role: DOCUMENT_TYPE_CLASSIFIER_ROLE });
  });
});
