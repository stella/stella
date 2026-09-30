import { useQuery } from "@tanstack/react-query";
import type { ResolveParams } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { contactOptions } from "@/lib/contacts/queries";

export const ContactBreadcrumb = ({
  contactId,
}: ResolveParams<"/contacts/$contactId">) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: contact } = useQuery(
    contactOptions(activeOrganizationId, contactId),
  );

  return (
    <BreadcrumbLink to="/contacts/$contactId">
      <BidiText>{contact?.displayName ?? contactId}</BidiText>
    </BreadcrumbLink>
  );
};
