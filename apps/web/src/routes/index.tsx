import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/auth", replace: true });
    }

    if (!context.session.activeOrganizationId) {
      throw redirect({ to: "/auth/organization", replace: true });
    }

    throw redirect({ to: "/workspaces", replace: true });
  },
});
