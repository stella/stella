import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { ContactImportStudio } from "./-contact-import.page";
import { ContactImportPending } from "./-contact-import.pending";

export const Route = createFileRoute("/_protected/contacts/import")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "contacts.importStudio.title",
      to: "/contacts/import",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("contacts.importStudio.title") }],
  }),
  component: ContactImportStudio,
  pendingComponent: ContactImportPending,
});
