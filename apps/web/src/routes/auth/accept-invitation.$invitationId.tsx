import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { InvitationPage } from "./-accept-invitation.page";
import { InvitationPending } from "./-accept-invitation.pending";
import { loadInvitationView } from "./-invitation-view.logic";

export const Route = createFileRoute("/auth/accept-invitation/$invitationId")({
  beforeLoad: ({ context, location }) => {
    if (!context.session || !context.user) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
        replace: true,
      });
    }
    return { signedInEmail: context.user.email };
  },
  loader: async ({ params }) => {
    const view = await loadInvitationView(params.invitationId);

    if (view.type === "missing") {
      throw notFound();
    }

    return view;
  },
  component: InvitationPage,
  pendingComponent: InvitationPending,
});
