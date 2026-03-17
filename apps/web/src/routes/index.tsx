import { createFileRoute, redirect } from "@tanstack/react-router";

import { api } from "@/lib/api";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/auth", replace: true });
    }

    if (!context.session.activeOrganizationId) {
      throw redirect({
        to: "/auth/organization",
        replace: true,
      });
    }

    const { data } = await api.workspaces.active.get();
    const lastActiveWorkspaceId = data?.lastActiveWorkspaceId;

    if (lastActiveWorkspaceId) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: lastActiveWorkspaceId },
        replace: true,
      });
    }

    throw redirect({ to: "/workspaces", replace: true });
  },
});
