import { createFileRoute, redirect } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

/** One retired research table; its questions are on the results table now. */
export const Route = createFileRoute("/law/cases/research/$tableId")({
  beforeLoad: () => {
    if (import.meta.env.SSR) {
      throw redirect({ to: "/law/cases", replace: true });
    }
  },
  component: redirectRouteComponent({ to: "/law/cases" }),
});
