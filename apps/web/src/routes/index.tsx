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

    let lastActiveWorkspaceId: string | null = null;
    try {
      const { data } = await api.workspaces["last-active"].get();
      lastActiveWorkspaceId = data?.lastActiveWorkspaceId ?? null;
    } catch {
      // Network or server error; fall through to workspace list.
    }

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
