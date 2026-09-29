import { createFileRoute, redirect } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { loadAuthContext } from "@/routes/-auth-context";
import { OnboardingWizard } from "@/routes/onboarding/-components/onboarding-wizard";
import { nativeToolDeployAvailabilityOptions } from "@/routes/onboarding/-queries";
import { onboardingSearchSchema } from "@/routes/onboarding/-search";

const isDev = import.meta.env.DEV;

export const Route = createFileRoute("/onboarding")({
  validateSearch: onboardingSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }

    // In dev, ?preview=true bypasses the "already has org" check
    if (isDev && search.preview) {
      return authContext;
    }

    if (authContext.session.activeOrganizationId) {
      throw redirect({ href: search.redirectTo ?? "/", replace: true });
    }

    return authContext;
  },
  loader: async ({ context: { queryClient } }) => {
    await ensureRouteQueryData(
      queryClient,
      nativeToolDeployAvailabilityOptions,
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("onboarding.orgTitle") }],
  }),
  component: OnboardingWizard,
});
