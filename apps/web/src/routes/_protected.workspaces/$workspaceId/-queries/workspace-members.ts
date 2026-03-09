import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const workspaceMembersKeys = {
  all: (workspaceId: string) => ["workspace-members", workspaceId],
};

export const workspaceMembersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspaceMembersKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .members.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
