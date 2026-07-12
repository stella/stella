import { describe, expect, test } from "bun:test";

import {
  defineStellaSandbox,
  isAgentEngine,
  isAgentHarness,
  type StellaSandboxInput,
} from "./index";

const baseInput = (
  overrides: Partial<StellaSandboxInput> = {},
): StellaSandboxInput => ({
  runId: "run_123",
  engine: "cloud",
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/v1",
    token: "scoped-token",
  },
  cloudImage: "stella/agent-sandbox:latest",
  instructions: "Use the stella MCP tools to act on the workspace.",
  ...overrides,
});

describe("engine/harness guards", () => {
  test("accepts known engines and rejects others", () => {
    expect(isAgentEngine("cloud")).toBe(true);
    expect(isAgentEngine("local")).toBe(true);
    expect(isAgentEngine("gpu")).toBe(false);
  });

  test("accepts known harnesses and rejects others", () => {
    expect(isAgentHarness("codex")).toBe(true);
    expect(isAgentHarness("claude-code")).toBe(true);
    expect(isAgentHarness("bash")).toBe(false);
  });
});

describe("defineStellaSandbox", () => {
  test("builds a definition keyed by the run id", () => {
    const definition = defineStellaSandbox(baseInput());
    expect(definition.id).toBe("run_123");
    expect(definition.workspace?.source).toEqual({ type: "none" });
  });

  test("denies network by default so egress only flows through the MCP bridge", () => {
    const definition = defineStellaSandbox(baseInput());
    expect(definition.policy?.capabilities?.network).toBe("deny");
  });

  test("throws for the not-yet-implemented local engine rather than falling back to cloud", () => {
    expect(() => defineStellaSandbox(baseInput({ engine: "local" }))).toThrow(
      /local engine/u,
    );
  });
});
