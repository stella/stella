import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillDetailOptions } from "@/lib/knowledge/queries";
import { classifyToolEntry } from "@/lib/knowledge/tool-entry";

const toolEntryRoute = getRouteApi("/knowledge/tools_/$entry");

/** The entry's name: a skill's is read for the organization, a published
 *  tool's comes with the page. A tool's slug is never asked for as a skill. */
export const SkillBreadcrumb = () => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const entry = toolEntryRoute.useParams({ select: (params) => params.entry });
  const toolName = toolEntryRoute.useMatch({
    select: (match) =>
      match.loaderData?.page === "catalogue"
        ? match.loaderData.displayName
        : null,
  });
  const isSkill = classifyToolEntry(entry) === "skill";
  const { data: skill } = useQuery({
    ...skillDetailOptions(activeOrganizationId, entry),
    enabled: isSkill,
  });

  return (
    <BreadcrumbLink to="/knowledge/tools/$entry">
      {toolName ?? skill?.name ?? entry}
    </BreadcrumbLink>
  );
};
