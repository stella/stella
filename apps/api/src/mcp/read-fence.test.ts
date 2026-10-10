import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import type { chargeMcpReadBytes } from "@/api/lib/rate-limit/mcp-read-fence";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
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
};
const boundary = ({
  chargeReadBytes,
  result = output,
  maximum,
}: BoundaryOptions) =>
  createMcpHttpRequestHandler({
    chargeReadBytes,
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
    listMcpResources: () => [],
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async () =>
      asTestRaw<McpRequestContext>({ organizationId, userId }),
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
      for (const reason of ["period_exhausted", "unavailable"] as const) {
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
            : "action_admission_unavailable",
        );
        expect(JSON.stringify(body.result)).not.toContain("Příloha");
      }
    }));
});
