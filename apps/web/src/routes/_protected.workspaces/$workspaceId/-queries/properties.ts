import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { PropertyDependency, WorkspaceProperty } from "@/lib/types";

export const propertiesKeys = {
  all: (workspaceId: string) => ["properties", workspaceId],
};

export const propertiesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: propertiesKeys.all(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceProperty[]> => {
      const response = await api
        .properties({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.map(toWorkspaceProperty);
    },
    refetchOnMount: false,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

type RawWorkspaceProperty = Omit<
  WorkspaceProperty,
  "id" | "workspaceId" | "tool"
> & {
  id: string;
  workspaceId: string;
  tool:
    | Extract<WorkspaceProperty["tool"], { type: "manual-input" }>
    | (Omit<
        Extract<WorkspaceProperty["tool"], { type: "ai-model" }>,
        "dependencies"
      > & {
        dependencies: {
          dependsOnPropertyId: string;
          condition: PropertyDependency["condition"];
        }[];
      });
};

const toWorkspaceProperty = (
  property: RawWorkspaceProperty,
): WorkspaceProperty => {
  const id = toSafeId<"property">(property.id);
  const workspaceProperty = {
    ...property,
    id,
    workspaceId: toSafeId<"workspace">(property.workspaceId),
    tool:
      property.tool.type === "manual-input"
        ? property.tool
        : {
            ...property.tool,
            dependencies: property.tool.dependencies.map((dependency) => ({
              ...dependency,
              dependsOnPropertyId: toSafeId<"property">(
                dependency.dependsOnPropertyId,
              ),
            })),
          },
  } satisfies WorkspaceProperty;

  return workspaceProperty;
};
