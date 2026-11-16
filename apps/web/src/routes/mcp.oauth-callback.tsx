import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { OutcomeScreen } from "@stll/ui/outcome-screen";

import { StellaWordmark } from "@/components/stella-wordmark";
import { detached } from "@/lib/detached";
import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { broadcastMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

const KNOWLEDGE_MCP_PATH = "/knowledge/tools";

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
 * themselves cannot be closed by script, so it goes back to the integrations.
 */
function McpOAuthCallbackPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const status = Route.useSearch({ select: (search) => search.status });
  const reason = Route.useSearch({ select: (search) => search.reason });

  const connected = status === "connected";
  const outcome: McpOAuthOutcome = connected
    ? { status: "connected" }
    : { status: "error", reason: reason ?? "unexpected" };
  const title = connected
    ? t("knowledge.mcp.callbackConnectedTitle")
    : t("knowledge.mcp.callbackFailedTitle");

  return (
    <OutcomeScreen
      closeTab={{
        onBeforeClose: () => broadcastMcpOAuthOutcome(outcome),
        onStillOpen: () =>
          detached(
            navigate({ to: KNOWLEDGE_MCP_PATH }),
            "mcp-oauth-callback.navigate",
          ),
      }}
      description={
        connected
          ? t("knowledge.mcp.callbackConnectedDescription")
          : t("knowledge.mcp.callbackFailedDescription")
      }
      documentTitle={pageTitleLiteral(title)}
      title={title}
      tone={connected ? "success" : "error"}
      wordmark={<StellaWordmark className="h-4 w-auto" />}
    />
  );
}
