import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as v from "valibot";

import { detached } from "@/lib/detached";
import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { broadcastMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { pageTitle } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import {
  MCP_TOOLS_PATH,
  McpOAuthOutcomeScreen,
} from "@/routes/-mcp-oauth-outcome";

const searchSchema = routeSearchSchema({
  // A callback that does not say it connected reports a failure, never a
  // connection.
  status: v.optional(v.picklist(["connected", "error"]), "error"),
  slug: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export const Route = createFileRoute("/mcp/oauth-callback")({
  staticData: { appFrame: APP_FRAME_SCOPE.none },
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.mcp.title") }],
  }),
  component: McpOAuthCallbackPage,
});

/**
 * Where an integration's sign-in ends, in the popup the integrations page
 * opened: tell that page what happened and close. A tab the member opened
 * themselves cannot be closed by script: once connected it goes on to the
 * integrations, and after a failure it stays on the outcome and its way on.
 */
function McpOAuthCallbackPage() {
  const navigate = useNavigate();
  const status = Route.useSearch({ select: (search) => search.status });
  const reason = Route.useSearch({ select: (search) => search.reason });
  const slug = Route.useSearch({ select: (search) => search.slug });

  const connected = status === "connected";
  const outcome: McpOAuthOutcome = connected
    ? { status: "connected" }
    : { status: "error", reason: reason ?? "unexpected" };

  return (
    <McpOAuthOutcomeScreen
      closeTab={{
        onBeforeClose: () => broadcastMcpOAuthOutcome(outcome),
        onStillOpen: () => {
          if (connected) {
            detached(
              navigate({ to: MCP_TOOLS_PATH }),
              "mcp-oauth-callback.navigate",
            );
          }
        },
      }}
      outcome={outcome}
      slug={slug}
    />
  );
}
