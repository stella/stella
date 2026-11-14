import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { socialProviderSchema } from "@/components/auth/access-reset.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { redirectToSchema } from "@/lib/redirect";
import { routeSearchSchema } from "@/route-search-params";
import {
  loadSocialLinkHint,
  NO_SOCIAL_LINK_HINT,
} from "@/routes/auth/-components/social-link-hint";
import { SocialRecoveryPanel } from "@/routes/auth/-components/social-recovery-panel";
import { reportOAuthCallbackError } from "@/routes/auth/-error-report";

const searchSchema = routeSearchSchema({
  error: v.optional(v.string()),
  linkProvider: v.optional(socialProviderSchema),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/error")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ error: search.error }),
  loader: async ({ deps, context }) => {
    if (context.session || deps.error !== "account_not_linked") {
      return NO_SOCIAL_LINK_HINT;
    }
    return await loadSocialLinkHint((error) =>
      getAnalytics().captureError(error, {
        fingerprintKey: "auth.error.loader:failure",
        scope: { type: "request", method: "GET", routeTemplate: "/auth/error" },
      }),
    );
  },
  component: AuthError,
});

function AuthError() {
  const t = useTranslations();
  const search = Route.useSearch({
    select: ({ error, linkProvider, redirectTo }) => ({
      error,
      linkProvider,
      redirectTo,
    }),
  });
  const session = Route.useRouteContext({
    select: (context) => context.session,
  });
  const hint = Route.useLoaderData();
  useMountEffect(() => {
    reportOAuthCallbackError({
      errorCode: search.error,
      fallback: t("errors.actionFailed"),
    });
  });
  return <SocialRecoveryPanel {...search} signedIn={!!session} hint={hint} />;
}
