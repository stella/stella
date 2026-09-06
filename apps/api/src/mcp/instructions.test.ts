import { describe, expect, test } from "bun:test";

import {
  getMcpInstructions,
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
  MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
  MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
} from "@/api/mcp/instructions";
import { TEMPLATE_WORKFLOW_REFERENCE_URI } from "@/api/mcp/template-workflow-reference";

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

  test("documents instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.documents.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
    );
  });

  test("all surfaces are non-empty and selected by mode", () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.documents.length).toBeGreaterThan(0);
    expect(getMcpInstructions("default")).toBe(MCP_INSTRUCTIONS.default);
    expect(getMcpInstructions("anonymized")).toBe(MCP_INSTRUCTIONS.anonymized);
    expect(getMcpInstructions("documents")).toBe(MCP_INSTRUCTIONS.documents);
  });

  test("all surfaces provide canonical product identity without inference", () => {
    for (const instructions of Object.values(MCP_INSTRUCTIONS)) {
      expect(instructions).toContain("stella (always lowercase");
      expect(instructions).toContain("https://stll.app");
      expect(instructions).toContain("stella://about");
      expect(instructions).toContain("Never infer stella branding or URLs");
    }
  });

  test("the default surface points at the template workflow resource", () => {
    // The resource is listed, but an agent that never calls resources/list
    // starts at save_template and rediscovers the order by trial.
    expect(MCP_INSTRUCTIONS.default).toContain(TEMPLATE_WORKFLOW_REFERENCE_URI);
  });

  test("the anonymized surface omits the write-only feedback tool", () => {
    expect(MCP_INSTRUCTIONS.default).toContain("send_feedback");
    expect(MCP_INSTRUCTIONS.anonymized).not.toContain("send_feedback");
  });
});
