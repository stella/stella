import type { HarnessProvider, StellaSandboxRunInput } from "@stll/agent-engine";

import { env } from "@/api/env";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";

const MCP_SERVER_NAME = "stella";

const SANDBOX_INSTRUCTIONS =
  "You are running as a stella agent. Use the stella MCP server (registered in this workspace) for all workspace actions — reading and writing matters, documents, and knowledge. Do not attempt network access outside those tools.";

type ChatSandboxContext = {
  userId: string;
  organizationId: string;
  runId: string;
};

/**
 * Resolve whether a chat attempt should run inside an agent sandbox (plan
 * 050), and if so build the full run input — including a freshly minted,
 * user-attributed, least-privilege MCP token bound to this run.
 *
 * Returns `undefined` (the normal server-side model path) unless the feature is
 * enabled AND the engine config is complete. A missing piece never half-runs:
 * the attempt silently falls back to the model path. Harness credential
 * sourcing is env-provided for now; org BYOK sourcing is a follow-up.
 */
export const resolveChatSandboxPlan = async (
  context: ChatSandboxContext,
): Promise<StellaSandboxRunInput | undefined> => {
  if (!env.AGENT_SANDBOX_RUNS_ENABLED) {
    return undefined;
  }

  const image = env.AGENT_SANDBOX_IMAGE;
  const harnessModel = env.AGENT_SANDBOX_HARNESS_MODEL;
  const harnessApiKey = env.AGENT_SANDBOX_HARNESS_API_KEY;
  const mcpUrl = env.AGENT_SANDBOX_MCP_URL;
  if (!image || !harnessModel || !harnessApiKey || !mcpUrl) {
    return undefined;
  }

  const harnessProvider: HarnessProvider = env.AGENT_SANDBOX_HARNESS_BASE_URL
    ? "openai-compatible"
    : "openai";

  const { token } = await mintAgentRunToken({
    userId: context.userId,
    organizationId: context.organizationId,
    runId: context.runId,
  });

  return {
    runId: context.runId,
    engine: "cloud",
    harness: "codex",
    harnessProvider,
    harnessModel,
    harnessApiKey,
    ...(env.AGENT_SANDBOX_HARNESS_BASE_URL
      ? { harnessBaseUrl: env.AGENT_SANDBOX_HARNESS_BASE_URL }
      : {}),
    cloudImage: image,
    ...(env.AGENT_SANDBOX_DOCKER_SOCKET
      ? { cloudSocketPath: env.AGENT_SANDBOX_DOCKER_SOCKET }
      : {}),
    instructions: SANDBOX_INSTRUCTIONS,
    mcp: { serverName: MCP_SERVER_NAME, url: mcpUrl, token },
  };
};
