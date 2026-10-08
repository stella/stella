import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { socialProviderSchema } from "@/components/auth/access-reset.logic";
import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { redirectToSchema } from "@/lib/redirect";
import { SocialRecoveryPanel } from "@/routes/auth/-components/social-recovery-panel";

const searchSchema = v.object({
  error: v.optional(v.string()),
  linkProvider: v.optional(socialProviderSchema),
  redirectTo: redirectToSchema,
});
const hintSchema = v.object({
  method: v.nullable(socialProviderSchema),
  provider: v.nullable(socialProviderSchema),
});

export const Route = createFileRoute("/auth/error")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ error: search.error }),
  loader: async ({ deps, context }) => {
    if (context.session || deps.error !== "account_not_linked") {
      return { method: null, provider: null };
    }
    const { data, error } = await authClient.$fetch("/social-link-hint", {
      method: "POST",
    });
    if (error) {
      const cause = toAuthClientError(error);
      throw cause;
    }
    const parsed = v.safeParse(hintSchema, data);
    return parsed.success ? parsed.output : { method: null, provider: null };
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
