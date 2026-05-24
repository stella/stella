import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  ViewLayout,
  ViewLayoutType,
  ViewTemplateProperty,
} from "@/lib/types";

export type WorkspaceViewTemplate = {
  version: 1;
  id: string;
  name: string;
  layout: ViewLayout;
  templateProperties: ViewTemplateProperty[];
  layoutType: ViewLayoutType;
  createdAt: string;
  updatedAt: string;
};

export const viewTemplateKeys = {
  all: () => ["view-templates"] as const,
};

export const viewTemplatesOptions = (workspaceId: string) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- templates are scoped per-user-per-organization on the backend, so any workspaceId the caller has access to returns the same list. The path param only satisfies the workspace-access auth macro.
  queryOptions({
    queryKey: viewTemplateKeys.all(),
    queryFn: async ({ signal }): Promise<WorkspaceViewTemplate[]> => {
      const response = await api["view-templates"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
