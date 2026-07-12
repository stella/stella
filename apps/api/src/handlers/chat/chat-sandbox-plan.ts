import type { StellaSandboxRunInput } from "@stll/agent-engine";

import { env } from "@/api/env";

/**
 * Resolve whether a chat attempt should run inside an agent sandbox (plan
 * 050). Returns `undefined` — the normal server-side model path — unless the
 * feature is explicitly enabled AND a run plan has been selected for the
 * thread. Today nothing selects a plan, so this always returns `undefined`
 * and the sandbox seam in `runChatAttempt` stays dark; the resolver is the
 * single place that will gate engine selection (flag + org policy + desktop
 * bridge availability) once those land.
 */
export const resolveChatSandboxPlan = (): StellaSandboxRunInput | undefined => {
  if (!env.AGENT_SANDBOX_RUNS_ENABLED) {
    return undefined;
  }
  // Engine selection (org policy, desktop-bridge detection, MCP-token minting,
  // image/harness resolution) is not wired yet — see plan 050 phases 1-2.
  return undefined;
};
