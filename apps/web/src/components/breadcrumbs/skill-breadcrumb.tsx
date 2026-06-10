import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { skillDetailOptions } from "@/routes/_protected.knowledge/-queries";

const protectedRoute = getRouteApi("/_protected");
const skillRoute = getRouteApi("/_protected/knowledge/tools_/$skillId");

export const SkillBreadcrumb = () => {
  const activeOrganizationId = protectedRoute.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
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
