import { describe, expect, test } from "bun:test";

import {
  getMcpInstructions,
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
  MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
} from "@/api/mcp/instructions";

// The server `instructions` ride on every initialize response, so they are a
// per-session token cost. These budgets are hard ceilings: growth past them
// must be a deliberate, reviewed constant bump, not silent drift.
describe("MCP server instructions", () => {
  test("default instructions stay within the character budget", () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
    );
  });

  test("anonymized instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
    );
  });

  test("both surfaces are non-empty and selected by mode", () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeGreaterThan(0);
    expect(getMcpInstructions("default")).toBe(MCP_INSTRUCTIONS.default);
    expect(getMcpInstructions("anonymized")).toBe(MCP_INSTRUCTIONS.anonymized);
  });

  test("the anonymized surface omits the write-only feedback tool", () => {
    expect(MCP_INSTRUCTIONS.default).toContain("send_feedback");
    expect(MCP_INSTRUCTIONS.anonymized).not.toContain("send_feedback");
  });
});
