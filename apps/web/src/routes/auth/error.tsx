import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { socialProviderSchema } from "@/components/auth/access-reset.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { redirectToSchema } from "@/lib/redirect";
import {
  loadSocialLinkHint,
  NO_SOCIAL_LINK_HINT,
} from "@/routes/auth/-components/social-link-hint";
import { SocialRecoveryPanel } from "@/routes/auth/-components/social-recovery-panel";

const searchSchema = v.object({
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
      getAnalytics().captureError(error),
    );
  },
  component: AuthError,
});

function AuthError() {
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
  return <SocialRecoveryPanel {...search} signedIn={!!session} hint={hint} />;
}
