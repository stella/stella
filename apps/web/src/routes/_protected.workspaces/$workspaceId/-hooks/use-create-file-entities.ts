import { usePostHog } from "@posthog/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { MAX_PARALLEL_FILE_UPLOADS } from "@/consts";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

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

type UploadResult = Awaited<ReturnType<typeof uploadFileEntity>>;

type BatchUploadLabels = {
  uploading: string;
  uploadingDescription: string;
  uploadedSuccessfully: string;
  uploadFailed: string;
  progress: (completed: number, total: number) => string;
  partial: (failed: number, total: number) => string;
  renamed: (count: number) => string;
};

type BatchUploadOptions = {
  files: File[];
  workspaceId: string;
  propertyId: string;
  labels: BatchUploadLabels;
  onError?: (error: Error) => void;
};

export const useBatchUploadLabels = (): BatchUploadLabels => {
  const t = useTranslations();
  return {
    uploading: t("workspaces.files.uploading"),
    uploadingDescription: t("workspaces.files.uploadingDescription"),
    uploadedSuccessfully: t("workspaces.files.uploadedSuccessfully"),
    uploadFailed: t("errors.uploadFailed"),
    progress: (completed, total) =>
      t("workspaces.files.uploadingProgress", {
        completed,
        total,
      }),
    partial: (failed, total) =>
      t("workspaces.files.uploadedPartially", {
        failed,
        total,
      }),
    renamed: (count) =>
      t("workspaces.files.renamedToAvoidConflicts", { count }),
  };
};

/**
 * Uploads files in batches with progress tracking and toast
 * notifications. Used by both the main upload hook and kanban.
 */
export const uploadFileEntitiesBatched = async ({
  files,
  workspaceId,
  propertyId,
  labels,
  onError,
}: BatchUploadOptions): Promise<UploadResult[]> => {
  if (files.length === 0) {
    return [];
  }

  const total = files.length;
  const showProgress = total > 1;

  const toastId = toastManager.add({
    type: "loading",
    title: labels.uploading,
    description: showProgress
      ? labels.progress(0, total)
      : labels.uploadingDescription,
  });

  let uploaded = 0;
  let renamedCount = 0;
  const failedFiles: string[] = [];
  const allResults: UploadResult[] = [];

  for (let i = 0; i < files.length; i += MAX_PARALLEL_FILE_UPLOADS) {
    const batch = files.slice(i, i + MAX_PARALLEL_FILE_UPLOADS);

    const results = await Promise.all(
      batch.map((file) => uploadFileEntity(file, workspaceId, propertyId)),
    );

    for (const [idx, result] of results.entries()) {
      allResults.push(result);

      if (Result.isError(result)) {
        onError?.(result.error);
        const file = batch[idx];
        if (file) {
          failedFiles.push(file.name);
        }
      } else {
        uploaded++;
        if (result.value.renamed) {
          renamedCount++;
        }
      }
    }

    if (showProgress && uploaded + failedFiles.length < total) {
      toastManager.update(toastId, {
        description: labels.progress(uploaded, total),
      });
    }
  }

  const failedCount = failedFiles.length;
  const successCount = files.length - failedCount;

  if (failedCount === 0) {
    toastManager.update(toastId, {
      type: "success",
      title: labels.uploadedSuccessfully,
      description: undefined,
    });
  } else if (successCount > 0) {
    toastManager.update(toastId, {
      type: "warning",
      title: labels.partial(failedCount, files.length),
      description: formatFailedFiles(failedFiles),
    });
  } else {
    toastManager.update(toastId, {
      type: "error",
      title: labels.uploadFailed,
      description: formatFailedFiles(failedFiles),
    });
  }

  if (renamedCount > 0) {
    toastManager.add({
      title: labels.renamed(renamedCount),
      type: "info",
    });
  }

  return allResults;
};

export const useCreateFileEntities = (workspaceId: string) => {
  const t = useTranslations();
  const labels = useBatchUploadLabels();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
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

      await uploadFileEntitiesBatched({
        files,
        workspaceId,
        propertyId,
        labels,
        onError: (error) => captureError(posthog, error),
      });
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
