import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { contactOptions } from "@/routes/_protected.contacts/-queries";

const protectedRouteApi = getRouteApi("/_protected");

export const ContactBreadcrumb = ({
  contactId,
}: ResolveParams<"/contacts/$contactId">) => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: contact } = useQuery(
    contactOptions(activeOrganizationId, contactId),
  );

  return (
    <BreadcrumbLink to="/contacts/$contactId">
      {contact?.displayName ?? contactId}
    </BreadcrumbLink>
  );
};
