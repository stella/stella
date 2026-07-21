import { describe, expect, test } from "bun:test";

import {
  defineStellaSandbox,
  isAgentEngine,
  isAgentHarness,
  resolveStellaSandboxRun,
  SANDBOX_NO_MCP,
  type StellaSandboxInput,
  type StellaSandboxRunInput,
} from "./index";

const baseInput = {
  runId: "run_123",
  engine: "cloud",
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/v1",
    token: "scoped-token",
  },
  cloudImage: "stella/agent-sandbox:latest",
  cloudNetworkMode: "stella-egress-restricted",
  instructions: "Use the stella MCP tools to act on the workspace.",
} as const satisfies StellaSandboxInput;

const baseRunInput = {
  ...baseInput,
  harness: "codex",
  harnessProvider: "openai",
  harnessModel: "gpt-4o-mini",
  harnessApiKey: "sk-test",
} as const satisfies StellaSandboxRunInput;

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
    const definition = defineStellaSandbox(baseInput);
    expect(definition.id).toBe("run_123");
    expect(definition.workspace?.source).toEqual({ type: "none" });
  });

  test("denies network by default so egress only flows through the MCP bridge", () => {
    const definition = defineStellaSandbox(baseInput);
    expect(definition.policy?.capabilities?.network).toBe("deny");
  });

  test("fails closed when a non-interactive harness needs fresh approval", () => {
    const definition = defineStellaSandbox(baseInput);
    expect(definition.policy?.default).toBe("ask");
    expect(definition.policy?.commands?.deny).toEqual(
      expect.arrayContaining(["sudo *", "rm -rf /*", "curl *", "wget *"]),
    );
  });

  test("destroys each run without snapshotting delegated credentials", () => {
    const definition = defineStellaSandbox(baseInput);
    expect(definition.lifecycle).toMatchObject({
      reuse: "none",
      snapshot: "none",
      destroyOnComplete: true,
    });
  });

  test("throws for the not-yet-implemented local engine rather than falling back to cloud", () => {
    expect(() =>
      defineStellaSandbox({ ...baseInput, engine: "local" }),
    ).toThrow(/local engine/u);
  });

  test("a real binding projects an MCP tool surface into the workspace", () => {
    const definition = defineStellaSandbox(baseInput);
    expect(definition.workspace?.skills?.length).toBe(1);
  });

  test("the SANDBOX_NO_MCP sentinel yields no tool surface", () => {
    const definition = defineStellaSandbox({
      ...baseInput,
      mcp: SANDBOX_NO_MCP,
    });
    expect(definition.workspace?.skills ?? []).toHaveLength(0);
  });
});

describe("bun docker provider capabilities", () => {
  test("disables snapshots so image commits cannot persist credentials", async () => {
    const { bunDockerSandbox } = await import("./bun-docker/provider");
    const provider = bunDockerSandbox({ image: "stella/agent-sandbox:dev" });
    expect(provider.capabilities().snapshots).toBe(false);
    expect(provider.restoreSnapshot).toBeUndefined();
  });
});

describe("resolveStellaSandboxRun", () => {
  test("pairs a codex adapter with sandbox middleware", () => {
    const { adapter, middleware } = resolveStellaSandboxRun(baseRunInput);
    expect(adapter.name).toBe("codex");
    expect(middleware).toBeDefined();
  });
});
