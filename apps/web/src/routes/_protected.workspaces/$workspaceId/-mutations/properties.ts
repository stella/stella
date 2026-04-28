import { useMutation } from "@tanstack/react-query";

import type { PropertyContentType } from "@stella/api/types";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { PropertyDependency, WorkspaceProperty } from "@/lib/types";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type CreatePropertyDependency = {
  dependsOnPropertyId: string;
  condition: PropertyDependency["condition"];
};

type CreatePropertyVars = {
  name: string;
  contentType: PropertyContentType;
  toolType?: "ai-model" | "manual-input";
  prompt?: string;
  dependencies?: CreatePropertyDependency[];
};

export const useCreateProperty = ({ workspaceId }: { workspaceId: string }) => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      name,
      contentType,
      toolType,
      prompt,
      dependencies,
    }: CreatePropertyVars) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          queryKey: propertiesKeys.all(workspaceId),
          name,
          contentType,
          ...(toolType ? { toolType } : {}),
          ...(prompt === undefined ? {} : { prompt }),
          ...(dependencies && dependencies.length > 0
            ? {
                dependencies: dependencies.map((dep) => ({
                  dependsOnPropertyId: toSafeId<"property">(
                    dep.dependsOnPropertyId,
                  ),
                  condition: dep.condition,
                })),
              }
            : {}),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdatePropertyVars = {
  workspaceId: string;
  propertyId: string;
  name: string;
  content: WorkspaceProperty["content"];
  tool: WorkspaceProperty["tool"];
};

export const useUpdateProperty = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      propertyId,
      name,
      content,
      tool,
    }: UpdatePropertyVars) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .property({ propertyId: toSafeId<"property">(propertyId) })
        .post({
          queryKey: propertiesKeys.all(workspaceId),
          name,
          content,
          tool:
            tool.type === "ai-model"
              ? {
                  ...tool,
                  dependencies: tool.dependencies.map((dependency) => ({
                    ...dependency,
                    dependsOnPropertyId: toSafeId<"property">(
                      dependency.dependsOnPropertyId,
                    ),
                  })),
                }
              : tool,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeletePropertyVars = {
  workspaceId: string;
  propertyId: string;
};

export const useDeleteProperty = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, propertyId }: DeletePropertyVars) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .property({ propertyId: toSafeId<"property">(propertyId) })
        .delete({
          queryKey: propertiesKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
