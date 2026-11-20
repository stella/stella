import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { pageTitle } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

import { McpOAuthCallbackPage } from "./-mcp.oauth-callback.page";
import { McpOAuthCallbackPending } from "./-mcp.oauth-callback.pending";

const searchSchema = routeSearchSchema({
  // A callback that does not say it connected reports a failure, never a
  // connection.
  status: v.optional(v.picklist(["connected", "error"]), "error"),
  slug: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export const Route = createFileRoute("/mcp/oauth-callback")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    pendingText: "request-locale",
  },
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.mcp.title") }],
  }),
  component: McpOAuthCallbackPage,
  pendingComponent: McpOAuthCallbackPending,
});
