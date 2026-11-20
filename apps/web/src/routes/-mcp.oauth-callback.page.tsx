import { getRouteApi, useNavigate } from "@tanstack/react-router";

import { OutcomeScreen } from "@stll/ui/outcome-screen";

import { detached } from "@/lib/detached";
import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { broadcastMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";

import { MCP_TOOLS_PATH, useMcpOAuthOutcomeScreen } from "./-mcp-oauth-outcome";
import { McpOAuthCallbackShell } from "./-mcp.oauth-callback.pending";

const routeApi = getRouteApi("/mcp/oauth-callback");

/**
 * Where an integration's sign-in ends, in the popup the integrations page
 * opened: tell that page what happened and close. A tab the member opened
 * themselves cannot be closed by script: once connected it goes on to the
 * integrations, and after a failure it stays on the outcome and its way on.
 */
export function McpOAuthCallbackPage() {
  const navigate = useNavigate();
  const status = routeApi.useSearch({ select: (search) => search.status });
  const reason = routeApi.useSearch({ select: (search) => search.reason });
  const slug = routeApi.useSearch({ select: (search) => search.slug });

  const connected = status === "connected";
  const outcome: McpOAuthOutcome = connected
    ? { status: "connected" }
    : { status: "error", reason: reason ?? "unexpected" };

  const screen = useMcpOAuthOutcomeScreen({
    outcome,
    slug,
    closeTab: {
      onBeforeClose: () => broadcastMcpOAuthOutcome(outcome),
      onStillOpen: () => {
        if (connected) {
          detached(
            navigate({ to: MCP_TOOLS_PATH }),
            "mcp-oauth-callback.navigate",
          );
        }
      },
    },
  });

  return <McpOAuthCallbackShell Screen={OutcomeScreen} screen={screen} />;
}
