import type { StellaSandboxRunInput } from "@stll/agent-engine";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";

const MCP_SERVER_NAME = "stella";

const SANDBOX_INSTRUCTIONS =
  "You are running as a stella agent. Use the stella MCP server (registered in this workspace) for all workspace actions — reading and writing matters, documents, and knowledge. Do not attempt network access outside those tools.";

type ChatSandboxContext = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  runId: string;
  workspaceIds: readonly SafeId<"workspace">[];
};

/**
 * Build the full agent-sandbox run input (plan 050), including a freshly minted,
 * user-attributed, least-privilege MCP token bound to this run.
 *
 * The caller invokes this only for an explicit `runMode: "agent"` request, so
 * disabled or incomplete engine configuration fails closed. It must never
 * reroute an agent request to the normal model path and silently change its
 * execution or credential source.
 */
export const resolveChatSandboxPlan = async (
  context: ChatSandboxContext,
): Promise<StellaSandboxRunInput> => {
  if (!env.AGENT_SANDBOX_RUNS_ENABLED) {
    throw new HandlerError({
      status: 422,
      message: "Agent sandbox runs are not enabled for this deployment.",
    });
  }

  const image = env.AGENT_SANDBOX_IMAGE;
  const harnessModel = env.AGENT_SANDBOX_HARNESS_MODEL;
  const harnessApiKey = env.AGENT_SANDBOX_HARNESS_API_KEY;
  const mcpUrl = env.AGENT_SANDBOX_MCP_URL;
  const networkMode = env.AGENT_SANDBOX_DOCKER_NETWORK;
  if (!image || !harnessModel || !harnessApiKey || !mcpUrl || !networkMode) {
    // Enabled but under-configured: warn (without leaking values) so the
    // fallback to the model path is diagnosable rather than silent. Names
    // only — the sanitizing logger drops secret-shaped keys regardless.
    logger.warn("agent-sandbox: enabled but engine config incomplete", {
      missingImage: !image,
      missingHarnessModel: !harnessModel,
      missingHarnessApiKey: !harnessApiKey,
      missingMcpUrl: !mcpUrl,
      missingDockerNetwork: !networkMode,
    });
    throw new HandlerError({
      status: 502,
      message: "Agent sandbox configuration is incomplete.",
    });
  }

  const { token } = await mintAgentRunToken({
    userId: context.userId,
    organizationId: context.organizationId,
    runId: context.runId,
    workspaceIds: context.workspaceIds,
  });

  return {
    runId: context.runId,
    engine: "cloud",
    harness: "codex",
    ...(env.AGENT_SANDBOX_HARNESS_BASE_URL
      ? {
          harnessProvider: "openai-compatible",
          harnessBaseUrl: env.AGENT_SANDBOX_HARNESS_BASE_URL,
        }
      : { harnessProvider: "openai" }),
    harnessModel,
    harnessApiKey,
    cloudImage: image,
    ...(env.AGENT_SANDBOX_DOCKER_SOCKET
      ? { cloudSocketPath: env.AGENT_SANDBOX_DOCKER_SOCKET }
      : {}),
    cloudNetworkMode: networkMode,
    instructions: SANDBOX_INSTRUCTIONS,
    mcp: { serverName: MCP_SERVER_NAME, url: mcpUrl, token },
  };
};
