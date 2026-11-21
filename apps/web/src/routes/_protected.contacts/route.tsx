import { createFileRoute, Outlet } from "@tanstack/react-router";

import { LeafPendingView } from "@/routes/-route-pending-view";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/contacts")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "navigation.contacts",
      to: "/contacts",
    }),
  },
  component: ContactsLayout,
  // A layout: its pending view is the page it leads to.
  pendingComponent: LeafPendingView,
});

/** The contacts section: the list, a contact or the import, under the
 *  section's label. */
function ContactsLayout() {
  return <Outlet />;
}
