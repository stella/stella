import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import type { chargeMcpReadBytes } from "@/api/lib/rate-limit/mcp-read-fence";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { handoffLinkResult } from "@/api/mcp/web-handoff-links-core";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("read_org");
const userId = toSafeId<"user">("read_user");
const output = {
  content: [{ type: "text", text: "Příloha § 🗂" }],
  structuredContent: { text: "α" },
} satisfies CallToolResult;

type BoundaryOptions = {
  chargeReadBytes: typeof chargeMcpReadBytes;
  result?: CallToolResult;
  maximum?: number;
  decorateToolResult?: (result: CallToolResult) => Promise<CallToolResult>;
};
const boundary = ({
  chargeReadBytes,
  result = output,
  maximum,
  decorateToolResult,
}: BoundaryOptions) =>
  createMcpHttpRequestHandler({
    chargeReadBytes,
    agentAccessRefusal: async () => null,
    ...(decorateToolResult === undefined ? {} : { decorateToolResult }),
    actionSizePolicy: () =>
      Result.ok(
        maximum === undefined
          ? undefined
          : { responseBytes: maximum, requestBytes: 4093, pageSize: 13 },
      ),
    authenticateMcpRequest: async () =>
      Result.ok({
        organizationId,
        userId,
        scopes: [...MCP_ALL_RESOURCE_SCOPES],
      }),
    captureError: () => undefined,
    getMcpToolDefinition: async (name, _context, mode) => {
      const definition = listStaticMcpToolDefinitions(mode).find(
        (tool) => tool.name === name,
      );
      if (!definition) {
        panic(`Missing tool ${name}`);
      }
      return definition;
    },
    getMcpToolRequiredScopesHint: () => undefined,
    handleMcpToolCall: async () => result,
    listMcpTools: async () => [],
    listMcpResources: async () => [],
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async () =>
      asTestRaw<AuthorizedMcpRequestContext>({ organizationId, userId }),
  });

const call = async (
  handler: ReturnType<typeof boundary>,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { mode: "advanced" },
  );
  expect(response.status).toBe(200);
  return await readTestJson<{
    jsonrpc: string;
    id: number;
    result: CallToolResult;
  }>(response);
};

const withFence = async (run: () => Promise<void>) => {
  const previous = env.FEATURE_MCP_READ_FENCE;
  env.FEATURE_MCP_READ_FENCE = true;
  try {
    await run();
  } finally {
    env.FEATURE_MCP_READ_FENCE = previous;
  }
};

describe("MCP emitted read bytes", () => {
  test("charges the final UTF-8 JSON-RPC envelope when size admission is off", async () =>
    withFence(async () => {
      const charges: Parameters<typeof chargeMcpReadBytes>[0][] = [];
      const result = await call(
        boundary({
          chargeReadBytes: async (options) => {
            charges.push(options);
            return Result.ok(undefined);
          },
        }),
        "list_matters",
      );
      expect(charges).toHaveLength(1);
      expect(charges.at(0)).toEqual({
        organizationId,
        userId,
        readClass: "tenant",
        bytes: Buffer.byteLength(JSON.stringify(result), "utf-8"),
      });
      expect(result.result).toEqual(output);
      expect(
        Buffer.byteLength(JSON.stringify(result), "utf-8"),
      ).toBeGreaterThan(JSON.stringify(result).length);
    }));

  test("fences and charges the decorated result with repeated handoff URLs", async () =>
    withFence(async () => {
      const url = "https://stella.example/workspaces/matter";
      const handoffResult = {
        content: [],
        structuredContent: { url, repeatedUrl: url },
      } satisfies CallToolResult;
      const decorated = await handoffLinkResult({
        result: handoffResult,
        appBaseUrl: "https://stella.example",
        mint: async (paths) => {
          expect(paths).toEqual(["/workspaces/matter"]);
          return "sh1_test";
        },
      });
      const expectedEnvelope = {
        jsonrpc: "2.0",
        id: 17,
        result: decorated,
      };
      const decoratedBytes = Buffer.byteLength(
        JSON.stringify(expectedEnvelope),
        "utf-8",
      );
      const undecoratedBytes = Buffer.byteLength(
        JSON.stringify({ ...expectedEnvelope, result: handoffResult }),
        "utf-8",
      );
      expect(decoratedBytes).toBeGreaterThan(undecoratedBytes);

      const charges: Parameters<typeof chargeMcpReadBytes>[0][] = [];
      const decorateToolResult = async (result: CallToolResult) =>
        await handoffLinkResult({
          result,
          appBaseUrl: "https://stella.example",
          mint: async (paths) => {
            expect(paths).toEqual(["/workspaces/matter"]);
            return "sh1_test";
          },
        });
      const accepted = await call(
        boundary({
          chargeReadBytes: async (options) => {
            charges.push(options);
            return Result.ok(undefined);
          },
          decorateToolResult,
          result: handoffResult,
        }),
        "list_matters",
      );
      expect(accepted.result).toEqual(decorated);
      expect(charges).toHaveLength(1);
      expect(charges.at(0)?.bytes).toBe(decoratedBytes);

      charges.length = 0;
      const refused = await call(
        boundary({
          chargeReadBytes: async (options) => {
            charges.push(options);
            return Result.ok(undefined);
          },
          decorateToolResult,
          maximum: undecoratedBytes,
          result: handoffResult,
        }),
        "list_matters",
      );
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining('"code":"result_too_large"'),
        },
      ]);
      expect(charges).toHaveLength(0);
    }));

  test("public and mixed results use their canonical classes across cursor rounds", async () =>
    withFence(async () => {
      const classes: string[] = [];
      const handler = boundary({
        chargeReadBytes: async ({ readClass }) => {
          classes.push(readClass);
          return Result.ok(undefined);
        },
      });
      await call(handler, "search_case_law");
      await call(handler, "read_capability", {
        capability: "legislation.search",
        query: {},
      });
      await call(handler, "read_capability", {
        capability: "matters.list",
        query: {},
      });
      await call(handler, "search", { query: "record" });
      await call(handler, "search", { query: "record", cursor: "next-page" });
      expect(classes).toEqual(["public", "public", "tenant", "both", "both"]);
    }));

  test("empty and error outputs and mutations never charge", async () =>
    withFence(async () => {
      let charges = 0;
      const chargeReadBytes: typeof chargeMcpReadBytes = async () => {
        charges++;
        return Result.ok(undefined);
      };
      for (const result of [
        { content: [] },
        { content: [{ type: "text", text: "" }], structuredContent: {} },
        { content: output.content, isError: true },
      ] satisfies CallToolResult[]) {
        await call(boundary({ chargeReadBytes, result }), "list_matters");
      }
      await call(boundary({ chargeReadBytes }), "write_capability", {
        capability: "matters.create",
        body: {},
      });
      expect(charges).toBe(0);
    }));

  test("flag off preserves output and never consults the fence", async () => {
    const previous = env.FEATURE_MCP_READ_FENCE;
    env.FEATURE_MCP_READ_FENCE = false;
    let charges = 0;
    try {
      const result = await call(
        boundary({
          chargeReadBytes: async () => {
            charges++;
            return Result.ok(undefined);
          },
        }),
        "list_matters",
      );
      expect(result.result).toEqual(output);
      expect(charges).toBe(0);
    } finally {
      env.FEATURE_MCP_READ_FENCE = previous;
    }
  });

  test("the byte ceiling rejects a read before charging its window", async () =>
    withFence(async () => {
      let charges = 0;
      const body = await call(
        boundary({
          maximum: 7,
          chargeReadBytes: async () => {
            charges++;
            return Result.ok(undefined);
          },
        }),
        "list_matters",
      );
      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body.result)).toContain("result_too_large");
      expect(charges).toBe(0);
    }));

  test("refusals preserve the canonical contract and withhold the read result", async () =>
    withFence(async () => {
      for (const reason of ["period_exhausted", "store_unavailable"] as const) {
        const body = await call(
          boundary({
            chargeReadBytes: async () =>
              Result.err(
                new ActionAdmissionError({ reason, message: "read refused" }),
              ),
          }),
          "list_matters",
        );
        expect(body.result.isError).toBe(true);
        expect(JSON.stringify(body.result)).toContain(
          reason === "period_exhausted"
            ? "action_period_exhausted"
            : "limiter_store_unavailable",
        );
        expect(JSON.stringify(body.result)).not.toContain("Příloha");
      }
    }));
});
