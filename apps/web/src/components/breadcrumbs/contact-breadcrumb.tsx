import { useQuery } from "@tanstack/react-query";
import type { ResolveParams } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { contactOptions } from "@/routes/_protected.contacts/-queries";

export const ContactBreadcrumb = ({
  contactId,
}: ResolveParams<"/contacts/$contactId">) => {
  const { data: contact } = useQuery(contactOptions(contactId));

  return (
    <BreadcrumbLink to="/contacts/$contactId">
      {contact?.displayName ?? contactId}
    </BreadcrumbLink>
  );
};
