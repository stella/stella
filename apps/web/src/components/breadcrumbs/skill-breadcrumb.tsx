import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { BreadcrumbQueryContent } from "@/components/breadcrumbs/query-content";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useSkillLabel } from "@/lib/knowledge/built-in-skills";
import { skillDetailOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";

const skillRoute = getRouteApi("/knowledge/tools_/skills/$skillId");
const toolEntryRoute = getRouteApi("/knowledge/tools_/$entry");

/** An organization's skill: its name, read for the organization. */
export const SkillBreadcrumb = () => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const skillLabel = useSkillLabel();
  const skillId = skillRoute.useParams({ select: (params) => params.skillId });
  const skillView = queryView(
    useQuery(skillDetailOptions(activeOrganizationId, userId, skillId)),
  );

  if (skillView.type !== "items") {
    return <BreadcrumbQueryContent view={skillView} />;
  }
  const skill = skillView.items;
  return (
    <>
      <BreadcrumbQueryContent view={skillView} />
      <BreadcrumbLink to="/knowledge/tools/skills/$skillId">
        {skillLabel({
          skillDisplayName: skill.name,
          skillId: skill.id,
          skillName: skill.slug,
        })}
      </BreadcrumbLink>
    </>
  );
};

/** A published tool: its name comes with the page. */
export const ToolBreadcrumb = () => {
  const entry = toolEntryRoute.useParams({ select: (params) => params.entry });
  const toolName = toolEntryRoute.useMatch({
    select: (match) => match.loaderData?.displayName ?? null,
  });
  return (
    <BreadcrumbLink to="/knowledge/tools/$entry">
      {toolName ?? entry}
    </BreadcrumbLink>
  );
};
