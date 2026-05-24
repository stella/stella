import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
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

export type ViewTemplatesKey = {
  organizationId: string;
};

export const viewTemplateKeys = {
  all: ({ organizationId }: ViewTemplatesKey) =>
    ["view-templates", organizationId] as const,
};

export type ViewTemplatesOptionsInput = QueryOptionsInput<
  ViewTemplatesKey,
  { workspaceId: string }
>;

export const viewTemplatesOptions = ({
  key,
  context,
}: ViewTemplatesOptionsInput) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- workspaceId is a path param to satisfy the workspace-access auth macro; the backend returns a per-user-per-organization list, so it must not be part of the cache identity.
  queryOptions({
    queryKey: viewTemplateKeys.all(key),
    queryFn: async ({ signal }): Promise<WorkspaceViewTemplate[]> => {
      const response = await api["view-templates"]({
        workspaceId: toSafeId<"workspace">(context.workspaceId),
      }).get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
