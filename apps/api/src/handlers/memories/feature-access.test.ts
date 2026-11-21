import { describe, expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { toSafeId } from "@/api/lib/branded-types";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import {
  AI_MEMORY_FEATURE_ID,
  CHAT_ONLY_FEATURE_TOOL_DEFINITIONS,
} from "@/api/lib/feature-access/registry";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";

import createMemory from "./create";
import createFirmMemory from "./create-firm";
import deleteMemory from "./delete";
import listMemories from "./list";
import { memoriesRoute } from "./routes";
import updateMemory from "./update";

const snapshot = createFeatureAccessSnapshot({
  organizationId: toSafeId<"organization">("org_test"),
  userId: toSafeId<"user">("user_test"),
  decisions: new Map(),
});

describe("memory feature admission", () => {
  const hiddenContext = {
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    featureAccessSnapshot: snapshot,
  };
  const endpoints = [
    {
      name: "create",
      config: createMemory.config,
      run: async () =>
        await createMemory.handler(
          createTestHandlerContext<Parameters<typeof createMemory.handler>[0]>(
            hiddenContext,
          ),
        ),
    },
    {
      name: "create firm",
      config: createFirmMemory.config,
      run: async () =>
        await createFirmMemory.handler(
          createTestHandlerContext<
            Parameters<typeof createFirmMemory.handler>[0]
          >(hiddenContext),
        ),
    },
    {
      name: "delete",
      config: deleteMemory.config,
      run: async () =>
        await deleteMemory.handler(
          createTestHandlerContext<Parameters<typeof deleteMemory.handler>[0]>(
            hiddenContext,
          ),
        ),
    },
    {
      name: "list",
      config: listMemories.config,
      run: async () =>
        await listMemories.handler(
          createTestHandlerContext<Parameters<typeof listMemories.handler>[0]>(
            hiddenContext,
          ),
        ),
    },
    {
      name: "update",
      config: updateMemory.config,
      run: async () =>
        await updateMemory.handler(
          createTestHandlerContext<Parameters<typeof updateMemory.handler>[0]>(
            hiddenContext,
          ),
        ),
    },
  ];
  for (const endpoint of endpoints) {
    test(`${endpoint.name} hides memory before data access`, async () => {
      expect(endpoint.config.featureAccess).toEqual({
        type: "required",
        featureId: AI_MEMORY_FEATURE_ID,
      });
      expect(await endpoint.run()).toEqual({
        code: 404,
        response: { message: "Not found" },
      });
    });
  }
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    test(`unavailable ${method} memory route stays hidden`, async () => {
      const path =
        method === "PATCH" || method === "DELETE"
          ? "/v1/memories/invalid-id"
          : "/v1/memories/";
      await using server = serveForTest(
        createHttpApp({ routes: memoriesRoute, middleware: [errorBoundary] }),
      );
      const response = await server.fetch(
        new Request(`http://localhost${path}`, { method }),
      );
      expect(response.status).toBe(404);
    });
  }
  test("chat discovery binds remember to caller feature admission", () => {
    const remember = CHAT_ONLY_FEATURE_TOOL_DEFINITIONS.find(
      ({ name }) => name === "remember",
    );
    expect(remember?.featureId).toBe(AI_MEMORY_FEATURE_ID);
    expect(
      isMcpDescriptorFeatureEnabled({
        context: {
          featureAccessSnapshot: snapshot,
          organizationId: toSafeId<"organization">("org_test"),
          userId: toSafeId<"user">("user_test"),
        },
        kind: "tools",
        id: "remember",
        featureId: remember?.featureId,
      }),
    ).toBe(false);
  });
});
