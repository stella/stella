import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillDetailOptions } from "@/lib/knowledge/queries";

const skillRoute = getRouteApi("/knowledge/tools_/$skillId");

export const SkillBreadcrumb = () => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const skillId = skillRoute.useParams({ select: (params) => params.skillId });
  const { data: skill } = useQuery(
    skillDetailOptions(activeOrganizationId, skillId),
  );

  return (
    <BreadcrumbLink to="/knowledge/tools/$skillId">
      {skill?.name ?? skillId}
    </BreadcrumbLink>
  );
};
