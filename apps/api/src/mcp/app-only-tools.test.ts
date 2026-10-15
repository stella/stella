import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { chatScriptReadToolNames } from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
} from "@/api/mcp/errors";
import { listGatewayMcpToolDefinitions } from "@/api/mcp/gateway/list-tools";
import { listOfferedStaticMcpToolDefinitions } from "@/api/mcp/gateway/static-tool-visibility";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
} from "@/api/mcp/tools";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

const appOnlyNames = [
  "read_case_law_decision_blocks",
  "preview_cited_provision",
] as const;

const requestContext = () =>
  asTestRaw<McpRequestContext>({
    organizationId: toSafeId<"organization">("org_test"),
    userId: toSafeId<"user">("user_test"),
    userEmail: "reader@example.test",
    memberRole: "owner",
    grantedScopes: ["stella:read"],
    enabledRegistrySlugs: [],
  });

type CallOptions = {
  toolName: string;
  access:
    | "granted"
    | "missing-scope"
    | "unauthenticated"
    | "organization-denied";
};
const call = async ({ toolName, access }: CallOptions) => {
  let calls = 0;
  const handler = createMcpHttpRequestHandler({
    actionSizePolicy: () => Result.ok(undefined),
    admitAction: async ({ run }) =>
      Result.ok(
        await run(new AbortController().signal, {
          reservePeriod: async () => Result.ok(undefined),
        }),
      ),
    chargeReadBytes: async () => Result.ok(undefined),
    authenticateMcpRequest: async () =>
      access === "unauthenticated"
        ? Result.err(
            new McpAuthenticationError({ message: "Invalid bearer token" }),
          )
        : Result.ok({
            organizationId: "org_test",
            userId: "user_test",
            scopes: access === "missing-scope" ? [] : ["stella:read"],
          }),
    captureError: () => undefined,
    getMcpToolDefinition,
    getMcpToolRequiredScopesHint,
    handleMcpToolCall: async () => {
      calls += 1;
      return { content: [{ type: "text", text: "app data" }] };
    },
    listMcpTools: async () => [],
    listMcpResources: () => [],
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async () => {
      if (access === "organization-denied") {
        throw new McpOrganizationAccessError({
          message: "Organization not accessible",
        });
      }
      return requestContext();
    },
  });
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: {} },
      }),
    }),
  );
  return { response, calls };
};

describe("app-only reader tool authorization", () => {
  test("hosts discover app-only tools while model projections exclude them", async () => {
    const context = requestContext();
    const host = await listGatewayMcpToolDefinitions({
      context,
      mode: "default",
      scopes: ["stella:read"],
    });
    const model = listOfferedStaticMcpToolDefinitions({
      context,
      mode: "default",
      scopes: ["stella:read"],
      audience: "model",
    });
    const chat = chatScriptReadToolNames();
    for (const name of appOnlyNames) {
      expect(getStaticMcpToolDefinition(name)?._meta?.["ui"]).toEqual({
        visibility: ["app"],
      });
      expect(host.some((tool) => tool.name === name)).toBe(true);
      expect(model.some((tool) => tool.name === name)).toBe(false);
      expect(chat).not.toContain(name);
    }
  });

  for (const toolName of appOnlyNames) {
    test(`${toolName} remains callable by an authorized app`, async () => {
      const { response, calls } = await call({ toolName, access: "granted" });
      expect(response.status).toBe(200);
      expect(calls).toBe(1);
      expect(
        await readTestJson<{ result: { content: unknown[] } }>(response),
      ).toMatchObject({
        result: { content: [{ type: "text", text: "app data" }] },
      });
    });

    test(`${toolName} refuses missing scope before dispatch`, async () => {
      const { response, calls } = await call({
        toolName,
        access: "missing-scope",
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(0);
      const body = await readTestJson<{
        result: { isError: boolean; content: { text: string }[] };
      }>(response);
      expect(body.result.isError).toBe(true);
      expect(body.result.content.at(0)?.text).toContain(
        '"code":"missing_scope"',
      );
    });

    for (const access of ["unauthenticated", "organization-denied"] as const) {
      test(`${toolName} refuses ${access} before dispatch`, async () => {
        const { response, calls } = await call({ toolName, access });
        expect(response.status).toBe(access === "unauthenticated" ? 401 : 403);
        expect(calls).toBe(0);
      });
    }
  }
});
