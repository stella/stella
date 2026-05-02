import { useSuspenseQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";

import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type UseActiveViewInput = {
  workspaceId: string;
  viewId?: string | undefined;
  page?: number | undefined;
};

const DEFAULT_VIEW_PAGE = 1;

export const useActiveView = ({
  workspaceId,
  viewId,
  page,
}: UseActiveViewInput) => {
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const activeViewId = viewId ?? viewMatch?.params.viewId;
  const activePage = page ?? viewMatch?.search.page ?? DEFAULT_VIEW_PAGE;
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => data.find((v) => v.id === activeViewId) ?? data.at(0),
  });

  const { filters, sorts } = activeView?.layout ?? {
    filters: [],
    sorts: [],
  };

  return {
    workspaceId,
    viewId: activeViewId,
    page: activePage,
    filters,
    sorts,
  };
};
