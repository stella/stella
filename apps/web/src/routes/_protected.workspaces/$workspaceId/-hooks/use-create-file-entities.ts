import { usePostHog } from "@posthog/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { toastManager } from "@stella/ui/components/toast";

import { MAX_PARALLEL_FILE_UPLOADS, MAX_PROJECT_ENTITIES } from "@/consts";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const MAX_DISPLAYED_FAILURES = 5;

const formatFailedFiles = (names: string[]): string => {
  const shown = names.slice(0, MAX_DISPLAYED_FAILURES);
  const remaining = names.length - shown.length;
  const list = shown.join(", ");
  if (remaining > 0) {
    return `${list} (+${remaining})`;
  }
  return list;
};

export const uploadFileEntity = (
  file: File,
  workspaceId: string,
  propertyId: string,
) =>
  Result.tryPromise(
    {
      try: async () => {
        const response = await api.entities({ workspaceId }).upload.post({
          queryKey: entitiesKeys.all(workspaceId),
          file,
          name: file.name,
          propertyId,
        });

        if (response.error) {
          throw toAPIError(response.error);
        }

        return {
          entityId: response.data.entityId,
          fileId: response.data.fileId,
          fileName: response.data.fileName,
          renamed: response.data.renamed,
        };
      },
      catch: (error) =>
        error instanceof APIError
          ? error
          : new APIError({
              status: 500,
              message: "Upload failed",
            }),
    },
    {
      retry: {
        times: 3,
        backoff: "exponential",
        delayMs: 500,
      },
    },
  );

export const useCreateFileEntities = (workspaceId: string) => {
  const t = useTranslations();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const data = useWorkspaceStore(useShallow((s) => s.data));
  const posthog = usePostHog();

  const mutation = useMutation({
    mutationFn: async (files: File[]) => {
      let propertyId = properties.find((p) => p.content.type === "file")?.id;

      if (!propertyId) {
        const response = await api.properties({ workspaceId }).put({
          queryKey: propertiesKeys.all(workspaceId),
          name: t("workspaces.files.defaultPropertyName"),
          contentType: "file",
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        propertyId = response.data.id;
      }

      const remainingSlots = MAX_PROJECT_ENTITIES - data.length;
      if (remainingSlots <= 0) {
        toastManager.add({
          title: t("workspaces.files.maxEntitiesReached"),
          type: "warning",
        });
        return;
      }

      const filesToUpload = files.slice(0, remainingSlots);

      const toastId = toastManager.add({
        type: "loading",
        title: t("workspaces.files.uploading"),
        description: t("workspaces.files.uploadingDescription"),
      });

      let renamedCount = 0;
      const failedFiles: string[] = [];

      for (
        let i = 0;
        i < filesToUpload.length;
        i += MAX_PARALLEL_FILE_UPLOADS
      ) {
        const batch = filesToUpload.slice(i, i + MAX_PARALLEL_FILE_UPLOADS);

        if (batch.length === 0) {
          break;
        }

        const results = await Promise.all(
          batch.map((file) => uploadFileEntity(file, workspaceId, propertyId)),
        );

        for (const [idx, result] of results.entries()) {
          if (Result.isError(result)) {
            captureError(posthog, result.error);
            const file = batch[idx];
            if (file) {
              failedFiles.push(file.name);
            }
          } else if (result.value.renamed) {
            renamedCount++;
          }
        }
      }

      const failedCount = failedFiles.length;
      const successCount = filesToUpload.length - failedCount;

      if (failedCount === 0) {
        toastManager.update(toastId, {
          type: "success",
          title: t("workspaces.files.uploadedSuccessfully"),
          description: undefined,
        });
      } else if (successCount > 0) {
        toastManager.update(toastId, {
          type: "warning",
          title: t("workspaces.files.uploadedPartially", {
            failed: failedCount,
            total: filesToUpload.length,
          }),
          description: formatFailedFiles(failedFiles),
        });
      } else {
        toastManager.update(toastId, {
          type: "error",
          title: t("errors.uploadFailed"),
          description: formatFailedFiles(failedFiles),
        });
      }

      if (renamedCount > 0) {
        toastManager.add({
          title: t("workspaces.files.renamedToAvoidConflicts", {
            count: renamedCount,
          }),
          type: "info",
        });
      }
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  const handleCreateFileEntities = (files: File[]) => {
    if (mutation.isPending || files.length === 0) {
      return;
    }

    mutation.mutate(files);
  };

  return [mutation.isPending, handleCreateFileEntities] as const;
};
