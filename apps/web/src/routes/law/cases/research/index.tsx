import { createFileRoute, redirect } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

/**
 * Research tables are retired: a question column belongs to the organization
 * and is asked on the results table itself, so a saved list of decisions has
 * nothing left to hold. Old links land on the results, where the questions and
 * their answers now live.
 */
export const Route = createFileRoute("/law/cases/research/")({
  // Preserve HTTP redirects for old links and let client navigation show the destination.
  beforeLoad: () => {
    if (import.meta.env.SSR) {
      throw redirect({ to: "/law/cases", replace: true });
    }
  },
  component: redirectRouteComponent({ to: "/law/cases" }),
});
