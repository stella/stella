import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  getOauthHashFragment,
  getSignedOauthQueryFromHash,
} from "@/lib/oauth-provider";
import { pageTitle } from "@/lib/page-title";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import { loadAuthContext } from "@/routes/-auth-context";

import { ConsentPage } from "./-consent.page";
import { ConsentPending } from "./-consent.pending";

export const Route = createFileRoute("/consent")({
  staticData: {
    appFrame: APP_FRAME_SCOPE.none,
    pendingText: "request-locale",
  },
  // Signed OAuth state arrives in the URL fragment, which HTTP omits.
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);
    const bridgedQuery = getSignedOauthQueryFromHash(location.hash);

    if (!authContext.session) {
      if (bridgedQuery) {
        throw redirect({
          href: `/auth#${getOauthHashFragment(bridgedQuery)}`,
          replace: true,
        });
      }

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
    meta: [{ title: pageTitle("consent.title") }],
  }),
  component: ConsentPage,
  pendingComponent: ConsentPending,
});
