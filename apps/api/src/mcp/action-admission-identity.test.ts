import { describe, expect, test } from "bun:test";

import { mcpActionPeriodIdentity } from "./action-admission-identity";

describe("MCP action period identity", () => {
  test("deduplicates the same RPC id only inside its session", () => {
    const first = mcpActionPeriodIdentity({
      sessionId: "session-a",
      rpcId: 1,
      requestId: "request-a",
    });
    expect(
      mcpActionPeriodIdentity({
        sessionId: "session-a",
        rpcId: 1,
        requestId: "request-b",
      }),
    ).toEqual(first);
    expect(
      mcpActionPeriodIdentity({
        sessionId: "session-b",
        rpcId: 1,
        requestId: "request-a",
      }).logicalPhaseId,
    ).not.toBe(first.logicalPhaseId);
    expect(
      mcpActionPeriodIdentity({
        sessionId: "session-a",
        rpcId: "1",
        requestId: "request-a",
      }).logicalPhaseId,
    ).not.toBe(first.logicalPhaseId);
    expect(first.actionKind).toBe("mcp.tools/call");
  });

  test("stateless requests get independent identities even if RPC ids repeat", () => {
    const first = mcpActionPeriodIdentity({
      sessionId: undefined,
      rpcId: 1,
      requestId: "request-a",
    });
    const second = mcpActionPeriodIdentity({
      sessionId: undefined,
      rpcId: 1,
      requestId: "request-b",
    });
    expect(first.logicalPhaseId).toBe("request-a");
    expect(second.logicalPhaseId).toBe("request-b");
  });
});
