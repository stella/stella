import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const viewRoute = getRouteApi("/_protected/workspaces/$workspaceId/$viewId");

export const useActiveView = () => {
  const { workspaceId, viewId } = viewRoute.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const page = viewRoute.useSearch({
    select: (s) => s.page ?? 1,
  });
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => data.find((v) => v.id === viewId) ?? data.at(0),
  });

  const { filters, sorts } = activeView?.layout ?? {
    filters: [],
    sorts: [],
  };

  return { workspaceId, viewId, page, filters, sorts };
};
