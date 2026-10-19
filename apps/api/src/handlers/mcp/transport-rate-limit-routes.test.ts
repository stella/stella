import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  createMcpAuthenticationFailureLimiter,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  MCP_TRANSPORT_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
  mcpTransportRateLimitKey,
} from "@/api/handlers/mcp/transport-rate-limit";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";

const createCountingContext = () => {
  let increments = 0;
  const context: RateLimitContext = {
    complete: () => {},
    decrement: () => {},
    increment: () => {
      increments += 1;
      return {
        count: increments,
        nextReset: new Date(Date.now() + 60_000),
        start: 0,
      };
    },
    init: () => {},
    kill: () => {},
  };
  return { context, increments: () => increments };
};

const ROUTE_CENSUS = [
  "/mcp",
  "/mcp/",
  "/mcp/advanced",
  "/mcp/advanced/",
  "/MCP",
  "/MCP/",
  "/mcp/Advanced",
  "/mcp/Advanced/",
  "/mcp%2F",
  "/mcp/%61dvanced",
  "/mcp/%61dvanced/",
] as const;

describe("MCP transport route metering", () => {
  test("charges both counters whenever a transport route runs", async () => {
    const transport = createCountingContext();
    const authentication = createCountingContext();
    let handlerRuns = 0;
    const app = new Elysia()
      .use(
        rateLimit({
          ...MCP_TRANSPORT_RATE_LIMIT_POLICY,
          context: transport.context,
          generator: mcpTransportRateLimitKey,
        }),
      )
      .use(
        createMcpRoute({
          handleMcpHttpRequest: async () => {
            handlerRuns += 1;
            return new Response("authentication required", { status: 401 });
          },
          limitAuthenticationFailure: createMcpAuthenticationFailureLimiter({
            ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
            context: authentication.context,
            generator: mcpTransportAddressRateLimitKey,
          }),
        }),
      );

    const outcomes: Record<string, boolean> = {};
    for (const path of ROUTE_CENSUS) {
      const before = {
        authentication: authentication.increments(),
        handler: handlerRuns,
        transport: transport.increments(),
      };
      await app.handle(
        new Request(`http://localhost${path}`, {
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          headers: {
            authorization: `Bearer route-census-${path}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      const ran = handlerRuns === before.handler + 1;
      outcomes[path] = ran;
      expect(transport.increments() === before.transport + 1).toBe(ran);
      expect(authentication.increments() === before.authentication + 1).toBe(
        ran,
      );
    }

    expect(outcomes).toEqual({
      "/mcp": true,
      "/mcp/": true,
      "/mcp/advanced": true,
      "/mcp/advanced/": true,
      "/MCP": false,
      "/MCP/": false,
      "/mcp/Advanced": false,
      "/mcp/Advanced/": false,
      "/mcp%2F": false,
      "/mcp/%61dvanced": false,
      "/mcp/%61dvanced/": false,
    });
  });
});
