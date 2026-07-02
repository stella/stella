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
  tool: RawWorkspacePropertyTool;
};

type RawPropertyDependency = {
  dependsOnPropertyId: string;
  condition: PropertyDependency["condition"];
};

type RawWorkspacePropertyTool =
  | (Omit<
      Extract<WorkspaceProperty["tool"], { type: "manual-input" }>,
      "dependencies"
    > & {
      dependencies?: RawPropertyDependency[];
    })
  | (Omit<
      Extract<WorkspaceProperty["tool"], { type: "ai-model" }>,
      "dependencies"
    > & {
      dependencies: RawPropertyDependency[];
    })
  | (Omit<
      Extract<WorkspaceProperty["tool"], { type: "playbook-verdict" }>,
      "askPropertyId" | "dependencies"
    > & {
      askPropertyId: string;
      dependencies: RawPropertyDependency[];
    });

const toWorkspaceProperty = (
  property: RawWorkspaceProperty,
): WorkspaceProperty => {
  const id = toSafeId<"property">(property.id);
  const workspaceProperty = {
    ...property,
    id,
    workspaceId: toSafeId<"workspace">(property.workspaceId),
    tool: toWorkspacePropertyTool(property.tool),
  } satisfies WorkspaceProperty;

  return workspaceProperty;
};

const toWorkspacePropertyTool = (
  tool: RawWorkspacePropertyTool,
): WorkspaceProperty["tool"] => {
  if (tool.type === "playbook-verdict") {
    return {
      ...tool,
      askPropertyId: toSafeId<"property">(tool.askPropertyId),
      dependencies: toPropertyDependencies(tool.dependencies),
    };
  }

  if (tool.type === "ai-model") {
    return {
      ...tool,
      dependencies: toPropertyDependencies(tool.dependencies),
    };
  }

  const { dependencies, ...manualTool } = tool;
  if (dependencies === undefined) {
    return manualTool;
  }

  return {
    ...manualTool,
    dependencies: toPropertyDependencies(dependencies),
  };
};

const toPropertyDependencies = (
  dependencies: RawPropertyDependency[],
): PropertyDependency[] =>
  dependencies.map((dependency) => ({
    ...dependency,
    dependsOnPropertyId: toSafeId<"property">(dependency.dependsOnPropertyId),
  }));
