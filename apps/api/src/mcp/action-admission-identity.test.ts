import { describe, expect, test } from "bun:test";

import { mcpActionPeriodIdentity } from "./action-admission-identity";

describe("MCP action period identity", () => {
  test("issues an independent phase for every call without accepting client correlation IDs", () => {
    const identities = Array.from({ length: 32 }, (_, index) =>
      mcpActionPeriodIdentity(index % 2 === 0),
    );
    expect(
      new Set(identities.map(({ logicalPhaseId }) => logicalPhaseId)).size,
    ).toBe(identities.length);
    for (const identity of identities) {
      expect(identity.logicalPhaseId.length).toBeGreaterThan(0);
    }
  });

  test("classifies service-consuming and own-data calls through admission kinds", () => {
    expect(mcpActionPeriodIdentity(true).actionKind).toBe("mcp.services/call");
    expect(mcpActionPeriodIdentity(false).actionKind).toBe("mcp.data/call");
  });
});
