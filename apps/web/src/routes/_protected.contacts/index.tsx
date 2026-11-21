import { createFileRoute } from "@tanstack/react-router";

import { contactsOptions } from "@/lib/contacts/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { ContactsPage } from "./-contacts.page";
import { ContactsPending } from "./-contacts.pending";

export const Route = createFileRoute("/_protected/contacts/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  loader: async ({ context }) => {
    await ensureRouteInfiniteQueryData(
      context.queryClient,
      contactsOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.contacts") }],
  }),
  component: ContactsPage,
  pendingComponent: ContactsPending,
});
