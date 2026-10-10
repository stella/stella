import { useQuery } from "@tanstack/react-query";
import type { ResolveParams } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";

import { BreadcrumbQueryContent } from "@/components/breadcrumbs/query-content";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { contactOptions } from "@/lib/contacts/queries";
import { useQueryView } from "@/lib/use-query-view";

export const ContactBreadcrumb = ({
  contactId,
}: ResolveParams<"/contacts/$contactId">) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const contactQuery = useQuery(
    contactOptions(activeOrganizationId, contactId),
  );
  const contactView = useQueryView(contactQuery);
  const contact = contactView.type === "items" ? contactView.items : undefined;

  if (contactView.type !== "items") {
    return <BreadcrumbQueryContent view={contactView} />;
  }
  return (
    <BreadcrumbQueryContent view={contactView}>
      <BreadcrumbLink to="/contacts/$contactId">
        <BidiText>{contact?.displayName ?? contactId}</BidiText>
      </BreadcrumbLink>
    </BreadcrumbQueryContent>
  );
};
