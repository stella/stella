import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { pageTitle } from "@/lib/page-title";
import { OnboardingWizard } from "@/routes/onboarding/-components/onboarding-wizard";

const isDev = import.meta.env.DEV;

const searchSchema = v.strictObject({
  preview: v.optional(v.boolean()),
});

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [{ title: pageTitle("onboarding.orgTitle") }],
  }),
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (!context.session) {
      throw redirect({ to: "/auth", replace: true });
    }

    // In dev, ?preview=true bypasses the "already has org" check
    if (isDev && search.preview) {
      return;
    }

    if (context.session.activeOrganizationId) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: OnboardingWizard,
});
