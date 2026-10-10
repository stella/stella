import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import {
  closeActionAdmissionRedis,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import {
  PER_KIND_PERIOD_SCOPE,
  resolveActionPeriodBudget,
} from "@/api/lib/rate-limit/action-period-budget";
import type { ActionSizePolicy } from "@/api/lib/rate-limit/action-size-limits";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpRequestContext } from "@/api/mcp/context";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

const state = createTestState({ file: import.meta.path, config: env });
const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const actionSizePolicy = {
  requestBytes: 2048,
  responseBytes: 2048,
  pageSize: 7,
} as const satisfies ActionSizePolicy;
if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("MCP action admission (valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  describe("MCP action admission (valkey)", () => {
    test("returns a completed nested tool result after late admission loss", async () => {
      const organizationId = toSafeId<"organization">(
        `mcp_completed_${Bun.randomUUIDv7()}`,
      );
      const userId = toSafeId<"user">("mcp_completed_user");
      const client = createRedisClient({ storeClass: "cache" });
      const errors: unknown[] = [];
      const tool =
        listStaticMcpToolDefinitions().find(
          ({ name }) => name === "list_matters",
        ) ?? panic("Missing list_matters tool definition");
      const accepted = {
        content: [{ type: "text", text: "accepted" }],
      } as const satisfies CallToolResult;
      const handleRequest = createMcpHttpRequestHandler({
        actionSizePolicy: () => Result.ok(actionSizePolicy),
        authenticateMcpRequest: async () =>
          Result.ok({ organizationId, userId, scopes: ["stella:read"] }),
        captureError: (error) => {
          errors.push(error);
        },
        getMcpToolDefinition: async () => tool,
        getMcpToolRequiredScopesHint: () => ["stella:read"],
        handleMcpToolCall: async () =>
          (
            await withActionAdmission({
              enabled: true,
              organizationId,
              userId,
              periodIdentity: {
                actionKind: "mcp.data/call",
                logicalPhaseId: "nested-completed",
              },
              run: async (signal) => {
                const lost = new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                await client.send("DEL", [
                  coordinationKey({
                    scope: "action-admission",
                    slot: organizationId,
                    suffix: "organization",
                  }),
                  coordinationKey({
                    scope: "action-admission",
                    slot: organizationId,
                    suffix: `user:${userId}`,
                  }),
                ]);
                await lost;
                expect(signal.aborted).toBe(true);
                return accepted;
              },
            })
          ).unwrap(),
        listMcpTools: async () => [],
        listMcpResources: () => [],
        readMcpResource: () => ({ contents: [] }),
        recordMcpSessionInitialized: () => undefined,
        resolveMcpSessionContext: async () =>
          asTestRaw<McpRequestContext>({ organizationId, userId }),
      });
      closeActionAdmissionRedis();
      state.patchConfig({
        FEATURE_ACTION_ADMISSION: true,
        ACTION_ADMISSION_ORG_CONCURRENCY: 1,
        ACTION_ADMISSION_USER_CONCURRENCY: 1,
        ACTION_ADMISSION_LEASE_MS: 1000,
        ACTION_ADMISSION_PERIOD_MS: 86_400_000,
        ACTION_ADMISSION_PERIOD_ACTIONS: 10,
      });
      try {
        await client.connect();
        const response = await handleRequest(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: "Bearer token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              id: 8,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: "list_matters", arguments: {} },
            }),
          }),
        );
        expect(response.status).toBe(200);
        const body = await readTestJson<{ result: CallToolResult }>(response);
        expect(body.result).toEqual(accepted);
        expect(errors).toHaveLength(0);
      } finally {
        client.close();
        closeActionAdmissionRedis();
      }
    });
    test("tools/call dispatches sharing a client RPC id consume distinct actions", async () => {
      const organizationId = toSafeId<"organization">(
        `mcp_period_${Bun.randomUUIDv7()}`,
      );
      const userId = toSafeId<"user">("mcp_period_user");
      const client = createRedisClient({ storeClass: "cache" });
      const errors: unknown[] = [];
      let dispatches = 0;
      const tool = listStaticMcpToolDefinitions().find(
        ({ name }) => name === "list_matters",
      );
      if (!tool) {
        panic("Missing list_matters tool definition");
      }
      const handleRequest = createMcpHttpRequestHandler({
        actionSizePolicy: () => Result.ok(actionSizePolicy),
        authenticateMcpRequest: async () =>
          Result.ok({ organizationId, userId, scopes: ["stella:read"] }),
        captureError: (error) => {
          errors.push(error);
        },
        getMcpToolDefinition: async () => tool,
        getMcpToolRequiredScopesHint: () => ["stella:read"],
        handleMcpToolCall: async () => {
          dispatches += 1;
          return { content: [{ type: "text", text: "ok" }] };
        },
        listMcpTools: async () => [],
        listMcpResources: () => [],
        readMcpResource: () => ({ contents: [] }),
        recordMcpSessionInitialized: () => undefined,
        resolveMcpSessionContext: async () =>
          asTestRaw<McpRequestContext>({ organizationId, userId }),
      });
      closeActionAdmissionRedis();
      state.patchConfig({
        FEATURE_ACTION_ADMISSION: true,
        ACTION_ADMISSION_ORG_CONCURRENCY: 2,
        ACTION_ADMISSION_USER_CONCURRENCY: 2,
        ACTION_ADMISSION_LEASE_MS: 120_000,
        ACTION_ADMISSION_PERIOD_MS: 86_400_000,
        ACTION_ADMISSION_PERIOD_ACTIONS: 2,
      });
      try {
        await client.connect();
        for (let dispatch = 0; dispatch < 2; dispatch += 1) {
          const response = await handleRequest(
            new Request("http://localhost/mcp", {
              method: "POST",
              headers: {
                accept: "application/json, text/event-stream",
                authorization: "Bearer token",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                id: 7,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { name: "list_matters", arguments: {} },
              }),
            }),
          );
          expect(response.status).toBe(200);
          const body = await readTestJson<{
            id: number;
            result: CallToolResult;
          }>(response);
          expect(body.id).toBe(7);
          expect(body.result.isError).not.toBe(true);
        }
        expect(dispatches).toBe(2);
        expect(errors).toHaveLength(0);
        const budget = resolveActionPeriodBudget({
          organizationId,
          identity: { actionKind: "mcp.data/call", logicalPhaseId: "lookup" },
          policy: { periodMs: 86_400_000, limit: 2 },
          scope: PER_KIND_PERIOD_SCOPE,
          nowMs: Temporal.Now.instant().epochMilliseconds,
        });
        if (Result.isError(budget) || budget.value === null) {
          throw new Error("Missing MCP budget");
        }
        expect(await client.send("HGET", [budget.value.key, "count"])).toBe(
          "2",
        );
        expect(await client.send("HLEN", [budget.value.key])).toBe(3);
      } finally {
        client.close();
        closeActionAdmissionRedis();
      }
    });
  });
}
