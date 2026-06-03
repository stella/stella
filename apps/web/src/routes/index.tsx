import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadAuthContext } from "@/routes/-auth-context";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session) {
      throw redirect({ to: "/law/cases", replace: true });
    }

    if (!authContext.session.activeOrganizationId) {
      throw redirect({
        to: "/auth/organization",
        replace: true,
      });
    }

    throw redirect({ to: "/chat", replace: true });
  },
});
