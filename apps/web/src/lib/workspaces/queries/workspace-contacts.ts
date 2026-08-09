import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { workspaceContactsQueryRoot } from "@/lib/resource-query-roots.logic";

export const workspaceContactsKeys = {
  all: workspaceContactsQueryRoot,
};

export const workspaceContactsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspaceContactsKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .contacts.get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });
