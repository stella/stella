import { describe, expect, test } from "bun:test";

import { MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_MAX_CHARS } from "../local";

describe("MCP server instructions", () => {
  test("stay within the char budget", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_MAX_CHARS,
    );
  });

  test("are substantial enough to cover the conventions", () => {
    // A near-empty string would silently pass the budget check; guard the floor.
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(400);
  });

  test("document the error envelope and the feedback path", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      '{"error":{"code","message","hint","retryable"}}',
    );
    expect(MCP_INSTRUCTIONS).toContain("send_feedback");
  });
});
