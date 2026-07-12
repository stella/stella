import {
  bearer,
  createSecrets,
  defineSandbox,
  defineWorkspace,
  mcpSkill,
  type SandboxDefinition,
} from "@tanstack/ai-sandbox";
import { panic } from "better-result";

import { bunDockerSandbox } from "./bun-docker/provider";
import { stellaSandboxPolicy } from "./policy";

/**
 * Where an agent run executes. `cloud` runs in a stella-operated Docker
 * sandbox metered on credits; `local` runs on the user's own machine through
 * the desktop bridge on their own harness login. Pinned per run at creation —
 * a run never migrates between engines.
 */
export const AGENT_ENGINES = ["cloud", "local"] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];

/**
 * Which coding-agent harness drives the run. `codex` is the launch harness
 * (sanctioned integration surface); others land behind their own approvals.
 */
export const AGENT_HARNESSES = ["codex", "claude-code", "opencode"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

const AGENT_ENGINE_SET: ReadonlySet<string> = new Set(AGENT_ENGINES);
const AGENT_HARNESS_SET: ReadonlySet<string> = new Set(AGENT_HARNESSES);

export const isAgentEngine = (value: string): value is AgentEngine =>
  AGENT_ENGINE_SET.has(value);

export const isAgentHarness = (value: string): value is AgentHarness =>
  AGENT_HARNESS_SET.has(value);

/**
 * How the in-sandbox harness reaches stella. The run gets workspace
 * capabilities ONLY through the bridged stella MCP server, never direct DB/S3
 * or a raw org API key, so permissions/audit/tenancy stay enforced server-side
 * in one place. `token` is a short-lived, workspace-scoped session token.
 */
export type StellaSandboxMcpBinding = {
  serverName: string;
  url: string;
  token: string;
};

/**
 * Explicit opt-out of the MCP tool surface. The only legitimate use is a
 * connectivity smoke test that exercises the harness without tools; a real
 * workspace run must pass a binding. Requiring this sentinel (rather than
 * allowing an omitted/optional field) makes "silently ran with no tools" a
 * type error at every call site instead of an easy mistake.
 */
export const SANDBOX_NO_MCP = "connectivity-smoke-test-no-mcp";
export type SandboxMcp = StellaSandboxMcpBinding | typeof SANDBOX_NO_MCP;

export type StellaSandboxInput = {
  /** Stable per-run id; also the sandbox definition id. */
  runId: string;
  engine: AgentEngine;
  /**
   * Bridged stella MCP server the harness talks to — the sole tool surface of
   * a real run. Required: pass a binding, or the explicit `SANDBOX_NO_MCP`
   * sentinel for a connectivity smoke test. It cannot be omitted.
   */
  mcp: SandboxMcp;
  /** Container image for the `cloud` engine (must ship the harness CLIs). */
  cloudImage: string;
  /**
   * Docker daemon unix socket for the `cloud` engine. Omit to use the ambient
   * daemon (`/var/run/docker.sock`); production points this at the
   * stella-operated host pool's socket.
   */
  cloudSocketPath?: string;
  /** AGENTS.md guidance written into the sandbox for the harness. */
  instructions: string;
  /** Keep a cloud sandbox warm between turns of one thread. Defaults to 10m. */
  keepAlive?: string;
};

const MCP_TOKEN_SECRET = "STELLA_MCP_TOKEN";

/**
 * Build the stella sandbox definition for one run. The result is passed to
 * `withSandbox()` as `chat()` middleware. Only the provider differs between
 * engines; the workspace, MCP binding, and policy are identical, so a run
 * streams the same chunks and enforces the same guardrails wherever it runs.
 *
 * The `local` engine is not wired here yet — the desktop bridge provider is a
 * follow-up (plan 050, phase 2). Passing `engine: "local"` throws so a
 * half-built path can never silently fall back to cloud.
 */
export const defineStellaSandbox = (
  input: StellaSandboxInput,
): SandboxDefinition => {
  if (input.engine === "local") {
    panic(
      "defineStellaSandbox: the local engine (desktop bridge provider) is not implemented yet",
    );
  }

  const mcp = input.mcp === SANDBOX_NO_MCP ? undefined : input.mcp;
  const mcpWorkspace = mcp
    ? (() => {
        const secrets = createSecrets({ [MCP_TOKEN_SECRET]: mcp.token });
        return {
          secrets,
          skills: [
            mcpSkill(mcp.serverName, {
              url: mcp.url,
              headers: { Authorization: bearer(secrets[MCP_TOKEN_SECRET]) },
            }),
          ],
        };
      })()
    : {};

  const workspace = defineWorkspace({
    // No repo: a stella agent run operates on workspace data via MCP tools,
    // not a checked-out tree.
    source: { type: "none" },
    instructions: input.instructions,
    ...mcpWorkspace,
  });

  return defineSandbox({
    id: input.runId,
    provider: bunDockerSandbox({
      image: input.cloudImage,
      ...(input.cloudSocketPath ? { socketPath: input.cloudSocketPath } : {}),
    }),
    workspace,
    policy: stellaSandboxPolicy(),
    lifecycle: {
      // No `snapshot` in v1: the bun-native provider does not implement image
      // commit yet, so warm reuse is by keeping the container alive per thread,
      // not by snapshotting. Snapshot support is a follow-up (plan 050).
      reuse: "thread",
      keepAlive: input.keepAlive ?? "10m",
      destroyOnComplete: false,
    },
  });
};
