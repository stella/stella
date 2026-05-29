import { useMutation } from "@tanstack/react-query";

import type { PropertyContentType } from "@stll/api/types";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  PropertyDependency,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
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
  options?: WorkspacePropertyOption[];
  fallback?: string | null;
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
      options,
      fallback,
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
          ...(options && options.length > 0 ? { options } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export type CreatePropertySpec = {
  name: string;
  contentType: PropertyContentType;
  toolType?: "ai-model" | "manual-input";
  prompt?: string;
  dependencies?: CreatePropertyDependency[];
};

export const useCreatePropertiesBatch = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ items }: { items: CreatePropertySpec[] }) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .batch.put({
          queryKey: propertiesKeys.all(workspaceId),
          items: items.map((item) => ({
            name: item.name,
            contentType: item.contentType,
            ...(item.toolType ? { toolType: item.toolType } : {}),
            ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
            ...(item.dependencies && item.dependencies.length > 0
              ? {
                  dependencies: item.dependencies.map((dep) => ({
                    dependsOnPropertyId: toSafeId<"property">(
                      dep.dependsOnPropertyId,
                    ),
                    condition: dep.condition,
                  })),
                }
              : {}),
          })),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
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

type PreviewPropertyVars = {
  workspaceId: string;
  prompt: string;
  contentType: "text" | "single-select" | "multi-select" | "date" | "int";
  entityId: string;
  options?: WorkspacePropertyOption[];
  dependencies?: { dependsOnPropertyId: string }[];
};

export const usePreviewProperty = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      prompt,
      contentType,
      entityId,
      options,
      dependencies,
    }: PreviewPropertyVars) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .preview.post({
          prompt,
          contentType,
          entityId: toSafeId<"entity">(entityId),
          ...(options && options.length > 0 ? { options } : {}),
          ...(dependencies && dependencies.length > 0
            ? {
                dependencies: dependencies.map((d) => ({
                  dependsOnPropertyId: toSafeId<"property">(
                    d.dependsOnPropertyId,
                  ),
                })),
              }
            : {}),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type SuggestPromptVars = {
  workspaceId: string;
  name: string;
  contentType: "text" | "single-select" | "multi-select" | "date" | "int";
  options?: { value: string }[];
  currentPrompt?: string;
};

export const useSuggestPrompt = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      name,
      contentType,
      options,
      currentPrompt,
    }: SuggestPromptVars) => {
      const response = await api
        .properties({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["suggest-prompt"].post({
          name,
          contentType,
          ...(options && options.length > 0
            ? { options: options.map((o) => ({ value: o.value })) }
            : {}),
          ...(currentPrompt && currentPrompt.length > 0
            ? { currentPrompt }
            : {}),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
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
