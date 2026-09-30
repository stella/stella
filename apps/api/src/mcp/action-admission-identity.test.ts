import { describe, expect, test } from "bun:test";

import { mcpActionPeriodIdentity } from "./action-admission-identity";

describe("MCP action period identity", () => {
  test("issues an independent phase for every call without accepting client correlation IDs", () => {
    const identities = Array.from({ length: 32 }, () =>
      mcpActionPeriodIdentity(),
    );
    expect(
      new Set(identities.map(({ logicalPhaseId }) => logicalPhaseId)).size,
    ).toBe(identities.length);
    for (const identity of identities) {
      expect(identity.actionKind).toBe("mcp.tools/call");
      expect(identity.logicalPhaseId.length).toBeGreaterThan(0);
    }
  });
});
