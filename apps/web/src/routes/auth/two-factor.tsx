import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { socialProviderSchema } from "@/components/auth/access-reset.logic";
import { TwoFactorPanel } from "@/components/auth/two-factor-panel";
import { redirectToSchema } from "@/lib/redirect";
import { routeSearchSchema } from "@/lib/route-search-params";
import { optionalFlagSearchSchema } from "@/lib/schema";

const searchSchema = routeSearchSchema({
  linkProvider: v.optional(socialProviderSchema),
  devQuickStart: optionalFlagSearchSchema,
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/two-factor")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect(
        search.linkProvider
          ? {
              to: "/auth/error",
              search: {
                error: "account_not_linked",
                linkProvider: search.linkProvider,
                redirectTo: search.redirectTo,
              },
              replace: true,
            }
          : {
              to: "/auth/organization",
              search: {
                devQuickStart: search.devQuickStart,
                redirectTo: search.redirectTo,
              },
              replace: true,
            },
      );
    }
  },
  component: TwoFactor,
});

function TwoFactor() {
  return <TwoFactorPanel />;
}
