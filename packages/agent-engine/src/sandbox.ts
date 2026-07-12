import { panic } from "better-result";

import {
  bearer,
  createSecrets,
  defineSandbox,
  defineWorkspace,
  mcpSkill,
  type SandboxDefinition,
} from "@tanstack/ai-sandbox";
import { dockerSandbox } from "@tanstack/ai-sandbox-docker";

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

export type StellaSandboxInput = {
  /** Stable per-run id; also the sandbox definition id. */
  runId: string;
  engine: AgentEngine;
  /** Bridged stella MCP server the harness talks to. */
  mcp: StellaSandboxMcpBinding;
  /** Container image for the `cloud` engine (must ship the harness CLIs). */
  cloudImage: string;
  /**
   * Dockerode connection options for the `cloud` engine (socket/host/port).
   * Omit to use the ambient Docker daemon; production points this at the
   * stella-operated host pool.
   */
  cloudDockerodeOptions?: Record<string, unknown>;
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

  const secrets = createSecrets({
    [MCP_TOKEN_SECRET]: input.mcp.token,
  });

  const workspace = defineWorkspace({
    // No repo: a stella agent run operates on workspace data via MCP tools,
    // not a checked-out tree.
    source: { type: "none" },
    secrets,
    instructions: input.instructions,
    skills: [
      mcpSkill(input.mcp.serverName, {
        url: input.mcp.url,
        headers: {
          Authorization: bearer(secrets[MCP_TOKEN_SECRET]),
        },
      }),
    ],
  });

  return defineSandbox({
    id: input.runId,
    provider: dockerSandbox({
      image: input.cloudImage,
      dockerodeOptions: input.cloudDockerodeOptions,
    }),
    workspace,
    policy: stellaSandboxPolicy(),
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      keepAlive: input.keepAlive ?? "10m",
      destroyOnComplete: false,
    },
  });
};
