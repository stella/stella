import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { pageTitle } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import { loadAuthContext } from "@/routes/-auth-context";

import { AgentClaimPage } from "./-agent-claim.page";
import { AgentClaimPending } from "./-agent-claim.pending";

const searchSchema = routeSearchSchema({
  user_code: v.optional(v.string()),
});

export const Route = createFileRoute("/agent-claim")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    pendingText: "request-locale",
  },
  validateSearch: searchSchema,
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session) {
      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    return { ...authContext, userId: authContext.session.userId };
  },
  head: () => ({
    meta: [{ title: pageTitle("agentClaim.title") }],
  }),
  component: AgentClaimPage,
  pendingComponent: AgentClaimPending,
});
