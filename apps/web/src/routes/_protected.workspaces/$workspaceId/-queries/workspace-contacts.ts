import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

export const workspaceContactsKeys = {
  all: (workspaceId: string) => ["workspace-contacts", workspaceId],
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
