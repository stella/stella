import { createFileRoute } from "@tanstack/react-router";

import { contactOptions } from "@/lib/contacts/queries";
import { loadRouteResource } from "@/lib/errors/route-resource";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { ContactDetailPage } from "./-contact-detail.page";
import { ContactDetailPending } from "./-contact-detail.pending";

export const Route = createFileRoute("/_protected/contacts/$contactId")({
  staticData: {
    presentation: routePresentation({ type: "entity", entity: "contact" }),
  },
  component: ContactDetailPage,
  loader: async ({ context, params }) => {
    // Prime the contact query the page suspends on so the fetch starts during
    // navigation instead of after the component mounts and suspends.
    await loadRouteResource({
      ids: [params.contactId],
      load: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          contactOptions(context.user.activeOrganizationId, params.contactId),
        ),
    });
  },
  pendingComponent: ContactDetailPending,
  remountDeps: ({ params }) => params.contactId,
});
