import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const workspacesKeys = {
  all: ["workspaces"],
  byId: (workspaceId: string) => [...workspacesKeys.all, workspaceId],
};

export const workspacesOptions = queryOptions({
  queryKey: workspacesKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api.workspaces.get({ fetch: { signal } });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});

export const workspaceOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspacesKeys.byId(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
