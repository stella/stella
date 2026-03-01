import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import type { PropertyContentType } from "@stella/api/types";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import type { WorkspaceProperty } from "@/lib/types";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type CreatePropertyVars = {
  name: string;
  contentType: PropertyContentType;
};

export const useCreateProperty = ({ workspaceId }: { workspaceId: string }) => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ name, contentType }: CreatePropertyVars) => {
      const response = await api.properties({ workspaceId }).put({
        queryKey: propertiesKeys.all(workspaceId),
        name,
        contentType,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      captureError(posthog, error);
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
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      propertyId,
      name,
      content,
      tool,
    }: UpdatePropertyVars) => {
      const response = await api
        .properties({ workspaceId })
        .property({ propertyId })
        .post({
          queryKey: propertiesKeys.all(workspaceId),
          name,
          content,
          tool,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeletePropertyVars = {
  workspaceId: string;
  propertyId: string;
};

export const useDeleteProperty = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, propertyId }: DeletePropertyVars) => {
      const response = await api
        .properties({ workspaceId })
        .property({ propertyId })
        .delete({
          queryKey: propertiesKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
