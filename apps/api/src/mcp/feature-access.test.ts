import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  chatCodeModeSystemPrompt,
  chatScriptReadToolNames,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { CHAT_READ_SCRIPT_POLICY } from "@/api/handlers/chat/tools/execute/chat-read-script-policy";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { runRegistryWriteTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-write-tool";
import { buildChatWriteTools } from "@/api/handlers/chat/tools/registry-write-tools";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { McpRequestContext } from "@/api/mcp/context";
import { isMcpFeatureInputEnabled } from "@/api/mcp/feature-access";
import {
  getGatewayMcpToolDefinition,
  listGatewayMcpToolDefinitions,
} from "@/api/mcp/gateway/list-tools";
import { getMcpInstructions } from "@/api/mcp/instructions";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { scopeHintToSurface } from "@/api/mcp/surface-tool-mentions";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  listMcpTools,
  handleMcpToolCall,
} from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

const featureId = "fixture-feature";
const organizationId = toSafeId<"organization">("org_fixture");
const userId = toSafeId<"user">("user_fixture");
const decision = decideFeatureAccess({
  registry: { [featureId]: { enrolment: "invitation" } },
  grants: {
    [featureId]: [
      { type: "member", organizationId, email: "member@example.test" },
    ],
  },
  featureId,
  organizationId,
  userId,
  user: { email: "member@example.test", emailVerified: true },
  membership: true,
});
const snapshot = createFeatureAccessSnapshot({
  organizationId,
  userId,
  decisions: new Map([[featureId, decision]]),
});
const bindings = {
  capabilities: new Map([["time-entries.create", featureId]]),
  tools: new Map([
    ["list_matters", featureId],
    ["prepare_feedback", featureId],
    ["save_matter", featureId],
  ]),
  resources: new Map([["stella://about", featureId]]),
};
const contextFor = (
  kind:
    | "enabled"
    | "hidden"
    | "missing"
    | "colleague"
    | "other-organization"
    | "ordinary",
) => {
  const scopedDb = mock(async () => []);
  const context = asTestRaw<McpRequestContext>({
    organizationId:
      kind === "other-organization" ? "org_other" : organizationId,
    userId: kind === "colleague" ? "user_other" : userId,
    memberRole: "owner",
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    userEmail: "member@example.test",
    grantedScopes: ["stella:read"],
    scopedDb,
    ...(kind === "ordinary"
      ? {}
      : {
          ...(kind === "missing"
            ? {}
            : {
                featureAccessSnapshot:
                  kind === "hidden"
                    ? createFeatureAccessSnapshot({
                        organizationId,
                        userId,
                        decisions: new Map(),
                      })
                    : snapshot,
              }),
          testDependencies: { featureAccessBindings: bindings },
        }),
  });
  const writeTools = buildChatWriteTools(
    asTestRaw<Parameters<typeof buildChatWriteTools>[0]>({
      ...context,
      memberRole: sessionMemberRole(context.memberRole),
      toolWorkspaceIds: resolveToolWorkspaceIds({
        accessibleWorkspaceIds: [],
        pinnedIds: [],
      }),
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      pinServerValidatedWorkspaceId: () => true,
    }),
  );
  return { context, scopedDb, writeTools };
};

describe("feature descriptor discovery and admission", () => {
  test.each(["flows", "signals"])(
    "%s descriptors remain hidden at native dispatch",
    async (hiddenFeatureId) => {
      const { context } = contextFor("hidden");
      const result = await handleMcpToolCall({
        context: {
          ...context,
          testDependencies: {
            ...context.testDependencies,
            featureAccessBindings: {
              ...bindings,
              tools: new Map([["list_matters", hiddenFeatureId]]),
            },
          },
        },
        toolName: "list_matters",
        args: {},
      });
      expect(JSON.stringify(result)).toContain("unknown_tool");
      expect(JSON.stringify(result)).not.toContain("feature_disabled");
    },
  );

  test.each([
    "ordinary",
    "enabled",
    "hidden",
    "missing",
    "colleague",
    "other-organization",
  ] as const)(
    "%s intersects script policy with caller feature access",
    (kind) => {
      const { context } = contextFor(kind);
      const expected = Object.entries(CHAT_READ_SCRIPT_POLICY).flatMap(
        ([name, policy]) =>
          policy === "script" &&
          // No fixture caller is enrolled in a registered feature.
          getStaticMcpToolDefinition(name)?.featureId === undefined &&
          (name !== "list_matters" || kind === "ordinary" || kind === "enabled")
            ? [name]
            : [],
      );
      expect(new Set<string>(chatScriptReadToolNames(context))).toEqual(
        new Set(expected),
      );
    },
  );

  for (const kind of [
    "missing",
    "hidden",
    "colleague",
    "other-organization",
  ] as const) {
    test(`${kind} omits tagged real tools, resources, prompts and hints`, async () => {
      const { context, scopedDb, writeTools } = contextFor(kind);
      const tools = await listGatewayMcpToolDefinitions({
        context,
        mode: "default",
        scopes: ["stella:read"],
      });
      expect(tools.some((tool) => tool.name === "list_matters")).toBe(false);
      expect(tools.some((tool) => tool.name === "read_document")).toBe(true);
      expect(
        await getGatewayMcpToolDefinition({
          context,
          mode: "default",
          toolName: "list_matters",
        }),
      ).toBeUndefined();
      const result = await handleMcpToolCall({
        context,
        mode: "default",
        toolName: "list_matters",
        args: {},
      });
      expect(JSON.stringify(result)).toContain("unknown_tool");
      expect(writeTools["save_matter"]).toBeUndefined();
      const readResult = await runRegistryReadTool({
        context,
        toolName: "list_matters",
        args: {},
        refRegistry: createChatRefRegistry(),
      });
      expect(readResult.isErr() && readResult.error.kind).toBe("unavailable");
      const writeResult = await runRegistryWriteTool({
        context,
        toolName: "save_matter",
        args: {},
        refRegistry: createChatRefRegistry(),
      });
      expect(writeResult.isErr() && writeResult.error.kind).toBe("unavailable");
      expect(scopedDb).not.toHaveBeenCalled();
      expect(
        listMcpResources("default", context).some(
          (resource) => resource.uri === "stella://about",
        ),
      ).toBe(false);
      const resourceRead = await Result.tryPromise({
        try: async () =>
          await readMcpResource("stella://about", "default", context),
        catch: (cause) => cause,
      });
      expect(resourceRead).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("Unknown resource") },
      });
      expect(getMcpInstructions("default", context)).not.toContain(
        "stella://about",
      );
      expect(getMcpInstructions("default", context)).not.toContain(
        "prepare_feedback",
      );
      expect(chatScriptReadToolNames(context)).not.toContain("list_matters");
      expect(chatCodeModeSystemPrompt([], context)).not.toContain(
        "list_matters",
      );
      expect(
        scopeHintToSurface("Call list_matters. Ask the person to continue.", {
          mode: "default",
          context,
        }),
      ).toBe("Ask the person to continue.");
    });
  }
  for (const kind of ["ordinary", "enabled"] as const) {
    test(`${kind} serves real ordinary and admitted descriptors`, async () => {
      const { context, scopedDb, writeTools } = contextFor(kind);
      const tools = await listGatewayMcpToolDefinitions({
        context,
        mode: "default",
        scopes: ["stella:read"],
      });
      expect(tools.some((tool) => tool.name === "list_matters")).toBe(true);
      expect(
        await getGatewayMcpToolDefinition({
          context,
          mode: "default",
          toolName: "list_matters",
        }),
      ).toBeDefined();
      expect(
        listMcpResources("default", context).some(
          (resource) => resource.uri === "stella://about",
        ),
      ).toBe(true);
      expect(
        (await readMcpResource("stella://about", "default", context)).contents
          .length,
      ).toBeGreaterThan(0);
      expect(getMcpInstructions("default", context)).toContain(
        "stella://about",
      );
      expect(chatScriptReadToolNames(context)).toContain("list_matters");
      expect(chatCodeModeSystemPrompt([], context)).toContain("list_matters");
      expect(writeTools["save_matter"]).toBeDefined();
      const admittedCall = await handleMcpToolCall({
        context,
        mode: "default",
        toolName: "list_matters",
        args: { status: "unknown-status" },
      });
      expect(JSON.stringify(admittedCall)).toContain("validation_error");
      expect(JSON.stringify(admittedCall)).not.toContain("unknown_tool");
      expect(scopedDb).not.toHaveBeenCalled();
      if (kind === "enabled") {
        expect(
          tools.find((tool) => tool.name === "list_matters")?._meta?.[
            "featureId"
          ],
        ).toBe(featureId);
      }
    });
  }
});

const modernRequest = (method: string, params: Record<string, unknown> = {}) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer fixture",
      "content-type": "application/json",
      "mcp-method": method,
      ...(typeof params["name"] === "string"
        ? { "mcp-name": params["name"] }
        : {}),
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: "stella-test", version: "1.0.0" },
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    }),
  });
for (const kind of [
  "missing",
  "hidden",
  "colleague",
  "other-organization",
  "enabled",
  "ordinary",
] as const) {
  test(`${kind} HTTP discovery uses real descriptors and context admission`, async () => {
    const { context, scopedDb } = contextFor(kind);
    const handler = createMcpHttpRequestHandler({
      actionSizePolicy: () => Result.ok(undefined),
      authenticateMcpRequest: async () =>
        Result.ok({
          organizationId: context.organizationId,
          userId: context.userId,
          scopes: ["stella:read"],
        }),
      resolveMcpSessionContext: async () => context,
      captureError: (error) => {
        throw error;
      },
      getMcpToolDefinition,
      getMcpToolRequiredScopesHint,
      handleMcpToolCall,
      listMcpTools,
      listMcpResources,
      readMcpResource,
      recordMcpSessionInitialized: () => undefined,
    });
    const toolsResponse = await handler(modernRequest("tools/list"));
    expect(toolsResponse.status).toBe(200);
    const toolsText = await toolsResponse.text();
    const resourcesResponse = await handler(modernRequest("resources/list"));
    expect(resourcesResponse.status).toBe(200);
    const resourceText = await resourcesResponse.text();
    if (kind === "ordinary" || kind === "enabled") {
      expect(toolsText).toContain('"name":"list_matters"');
      expect(resourceText).toContain("stella://about");
      if (kind === "enabled") {
        expect(toolsText).toContain(
          '"featureAccess":{"capabilities":["time-entries.create"]',
        );
        expect(toolsText).toContain('"featureId":"fixture-feature"');
      }
    } else {
      const deniedCall = await handler(
        modernRequest("tools/call", { name: "save_matter", arguments: {} }),
      );
      const deniedText = await deniedCall.text();
      expect(deniedText).toContain("unknown_tool");
      expect(deniedText).not.toContain("missing_scope");
      expect(toolsText).not.toContain("list_matters");
      expect(toolsText).not.toContain("prepare_feedback");
      expect(toolsText).not.toContain("time-entries.create");
      expect(resourceText).not.toContain("stella://about");
      expect(toolsText).toContain(
        '"featureAccess":{"capabilities":[],"tools":[]}',
      );
    }
    expect(scopedDb).not.toHaveBeenCalled();
  });
}

describe("mixed native task inputs", () => {
  test("denied list input stops before workspace lookup on MCP and chat", async () => {
    const { context, scopedDb } = contextFor("ordinary");
    const writable = {
      ...context,
      grantedScopes: ["stella:read", "stella:matters_write"],
    } satisfies McpRequestContext;
    const result = await handleMcpToolCall({
      context: writable,
      toolName: "save_task",
      args: {
        matter_id: "00000000-0000-4000-8000-000000000001",
        name: "Item",
        item_type: "fact",
      },
    });
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify({
        error: { code: "not_found", message: "Not found" },
      }),
    });
    expect(scopedDb).not.toHaveBeenCalled();
    const chat = await runRegistryWriteTool({
      context: writable,
      toolName: "save_task",
      args: { name: "Item", item_type: "fact" },
      refRegistry: createChatRefRegistry(),
    });
    expect(chat.isErr() && chat.error.kind).toBe("not-found");
    expect(scopedDb).not.toHaveBeenCalled();
  });

  for (const featureIds of [
    [],
    [LEGAL_LISTS_FEATURE_ID],
    [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
  ]) {
    test(`ordinary inputs and list inputs with ${featureIds.length} grants`, () => {
      const definition = getStaticMcpToolDefinition("save_task", "default");
      expect(definition).toBeDefined();
      if (definition === undefined) {
        panic("save_task declaration required");
      }
      const grants = Object.fromEntries(
        featureIds.map((id) => [
          id,
          [{ type: "organization" as const, organizationId }],
        ]),
      );
      const decisions = new Map(
        Object.keys(FEATURE_REGISTRY).map((id) => [
          id,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants,
            featureId: id,
            organizationId,
            userId,
            user: { email: "member@example.test", emailVerified: true },
            membership: true,
          }),
        ]),
      );
      const context = {
        organizationId,
        userId,
        featureAccessSnapshot: createFeatureAccessSnapshot({
          organizationId,
          userId,
          decisions,
        }),
      };
      expect(
        isMcpFeatureInputEnabled({
          context,
          definition,
          args: { item_type: "task" },
        }),
      ).toBe(true);
      expect(
        isMcpFeatureInputEnabled({
          context,
          definition,
          args: { item_type: null },
        }),
      ).toBe(true);
      for (const args of [
        { item_type: "fact" },
        { list_id: "list" },
        { list_description: "Description" },
      ]) {
        expect(isMcpFeatureInputEnabled({ context, definition, args })).toBe(
          featureIds.includes(LEGAL_LISTS_FEATURE_ID),
        );
      }
    });
  }
});

test("unavailable native task returns missing before destructive confirmation", async () => {
  const { context } = contextFor("ordinary");
  const database = createScopedDbMock({
    select: () => createSelectQueryMock([]),
  });
  const response = await handleMcpToolCall({
    context: {
      ...context,
      scopedDb: database.scopedDb,
      grantedScopes: ["stella:read", "stella:matters_write"],
    },
    toolName: "delete_task",
    args: { task_id: "00000000-0000-4000-8000-000000000001" },
  });
  expect(response.content).toContainEqual({
    type: "text",
    text: JSON.stringify({
      error: { code: "not_found", message: "Not found" },
    }),
  });
  expect(JSON.stringify(response)).not.toContain("confirmation_required");
  expect(database.getCallCount()).toBe(1);
});
