import { useCallback } from "react";

import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { MAX_PARALLEL_FILE_UPLOADS } from "@/consts";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { UploadQueue } from "@/lib/upload-queue";
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

type UploadResult = {
  entityId: string;
  fileId: string;
  fileName: string;
  renamed: boolean;
};

/**
 * Upload a single file via Eden. Throws on failure with the
 * HTTP status preserved on the error object. Attaches the raw
 * `Response` so the upload queue can read `Retry-After`.
 */
const uploadSingleFile = async (
  file: File,
  workspaceId: string,
  propertyId: string,
  signal: AbortSignal,
): Promise<UploadResult> => {
  const response = await api.entities({ workspaceId }).upload.post(
    {
      queryKey: entitiesKeys.all(workspaceId),
      file,
      name: file.name,
      propertyId,
    },
    { fetch: { signal } },
  );

  if (response.error) {
    const error = toAPIError(response.error);

    // Attach the raw Response so the queue can extract
    // the Retry-After header on 429 responses.
    if (response.response !== undefined) {
      Object.defineProperty(error, "response", {
        value: response.response,
        enumerable: false,
      });
    }

    throw error;
  }

  return {
    entityId: response.data.entityId,
    fileId: response.data.fileId,
    fileName: response.data.fileName,
    renamed: response.data.renamed,
  };
};

type BatchUploadLabels = {
  uploading: string;
  uploadingDescription: string;
  uploadedSuccessfully: string;
  uploadFailed: string;
  progress: (completed: number, total: number) => string;
  partial: (failed: number, total: number) => string;
  renamed: (count: number) => string;
  rateLimited: (seconds: number) => string;
  cancel: string;
  retryFailed: (count: number) => string;
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
      t("workspaces.files.renamedToAvoidConflicts", {
        count,
      }),
    rateLimited: (seconds) => t("workspaces.files.rateLimited", { seconds }),
    cancel: t("common.cancel"),
    retryFailed: (count) => t("workspaces.files.retryFailed", { count }),
  };
};

type BatchUploadOptions = {
  files: File[];
  workspaceId: string;
  propertyId: string;
  labels: BatchUploadLabels;
  onError?: (error: Error) => void;
};

/**
 * Uploads files using the queue with progress tracking and
 * toast notifications. Returns a promise that resolves when
 * the queue finishes.
 *
 * Used by both the main upload hook and kanban.
 */
export const uploadFileEntitiesBatched = async (
  options: BatchUploadOptions,
): Promise<UploadResult[]> => {
  const { files, workspaceId, propertyId, labels, onError } = options;

  if (files.length === 0) {
    return [];
  }

  return await new Promise<UploadResult[]>((resolve) => {
    const queue = new UploadQueue<UploadResult>(
      async (file, signal) =>
        await uploadSingleFile(file, workspaceId, propertyId, signal),
      MAX_PARALLEL_FILE_UPLOADS,
    );

    const initialTotal = files.length;
    const showProgress = initialTotal > 1;

    const toastId = toastManager.add({
      type: "loading",
      title: labels.uploading,
      description: showProgress
        ? labels.progress(0, initialTotal)
        : labels.uploadingDescription,
      timeout: 0,
      actionProps: {
        children: labels.cancel,
        onClick: () => queue.cancel(),
      },
    });

    queue.on("progress", () => {
      const { completed, total } = queue.getProgress();
      if (total > 1) {
        toastManager.update(toastId, {
          description: labels.progress(completed, total),
        });
      }
    });

    queue.on("rate-limited", ({ retryAfterS }) => {
      toastManager.update(toastId, {
        description: labels.rateLimited(retryAfterS),
      });
    });

    queue.on("resumed", () => {
      const { completed, total } = queue.getProgress();
      if (total > 1) {
        toastManager.update(toastId, {
          description: labels.progress(completed, total),
        });
      }
    });

    queue.on("done", ({ completed, failed, cancelled }) => {
      const { total } = queue.getProgress();

      const renamedCount = completed.filter((r) => r.renamed).length;

      for (const { error } of failed) {
        onError?.(error);
      }

      const failedNames = failed.map((f) => f.file.name);
      const failedCount = failedNames.length;
      const successCount = completed.length;

      if (cancelled) {
        toastManager.update(toastId, {
          type: successCount > 0 || failedCount > 0 ? "warning" : "info",
          title: labels.partial(failedCount, total),
          description:
            successCount > 0 ? labels.progress(successCount, total) : undefined,
          timeout: undefined,
          actionProps: undefined,
        });
      } else if (failedCount === 0) {
        toastManager.update(toastId, {
          type: "success",
          title: labels.uploadedSuccessfully,
          description: undefined,
          timeout: undefined,
          actionProps: undefined,
        });
      } else if (successCount > 0) {
        toastManager.update(toastId, {
          type: "warning",
          title: labels.partial(failedCount, total),
          description: formatFailedFiles(failedNames),
          timeout: 0,
          actionProps: {
            children: labels.retryFailed(failedCount),
            onClick: () => queue.retryFailed(),
          },
        });
      } else {
        toastManager.update(toastId, {
          type: "error",
          title: labels.uploadFailed,
          description: formatFailedFiles(failedNames),
          timeout: 0,
          actionProps: {
            children: labels.retryFailed(failedCount),
            onClick: () => queue.retryFailed(),
          },
        });
      }

      if (renamedCount > 0) {
        toastManager.add({
          title: labels.renamed(renamedCount),
          type: "info",
        });
      }

      resolve(completed);
    });

    queue.enqueue(files);
  });
};

export const useCreateFileEntities = (workspaceId: string) => {
  const t = useTranslations();
  const labels = useBatchUploadLabels();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const analytics = useAnalytics();

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
        onError: (error) => analytics.captureError(error),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const handleCreateFileEntities = useCallback(
    (files: File[]) => {
      if (mutation.isPending || files.length === 0) {
        return;
      }
      mutation.mutate(files);
    },
    [mutation],
  );

  return [mutation.isPending, handleCreateFileEntities] as const;
};
