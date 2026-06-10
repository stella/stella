import { useCallback } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { MAX_PARALLEL_FILE_UPLOADS } from "@/consts";
import type { DroppedFileTree } from "@/hooks/external-file-drop.logic";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { UploadQueue } from "@/lib/upload-queue";
import {
  buildDroppedFolderUploadPlan,
  type DroppedFolderUploadPlan,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/create-file-tree-upload.logic";
import { buildEntityCreatePresignPayload } from "@/routes/_protected.workspaces/$workspaceId/-hooks/create-file-upload-payload.logic";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

const MAX_DISPLAYED_FAILURES = 5;

const formatFailedFiles = (names: readonly string[]): string => {
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

type PreparedFileEntityUpload = {
  uploadId: string;
  parentId: string | null;
  url: string;
  headers: Record<string, string>;
};

/**
 * Hex-encode a SHA-256 hash already computed via Web Crypto. The
 * API stores hex on `fields.content.sha256Hex` and converts to
 * base64 for the S3 `x-amz-checksum-sha256` header.
 */
const bufferToHex = (buffer: ArrayBuffer): string => {
  const view = new Uint8Array(buffer);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

const hashFileSha256Hex = async (file: File): Promise<string> => {
  const fileBuffer = await file.arrayBuffer();
  const sha256Buffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  return bufferToHex(sha256Buffer);
};

type PrepareFolderTreeUploadOptions = {
  workspaceId: string;
  parentId: string | null;
  propertyId: string | null;
  plan: DroppedFolderUploadPlan;
};

type PreparedFolderTreeUpload = {
  files: File[];
  preparedUploadByFile: Map<File, PreparedFileEntityUpload>;
  parentIdByFile: Map<File, string | null>;
};

const prepareFolderTreeUpload = async ({
  workspaceId,
  parentId,
  propertyId,
  plan,
}: PrepareFolderTreeUploadOptions): Promise<PreparedFolderTreeUpload> => {
  const files = [];
  for (const [index, placement] of plan.files.entries()) {
    files.push({
      key: String(index),
      parentKey: placement.parentKey,
      name: placement.file.name,
      mimeType: placement.file.type || "application/octet-stream",
      size: placement.file.size,
      sha256Hex: await hashFileSha256Hex(placement.file),
    });
  }

  const response = await api
    .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["entity-create"].tree.post({
      queryKey: entitiesKeys.all(workspaceId),
      propertyId: propertyId ? toSafeId<"property">(propertyId) : null,
      parentId: parentId === null ? null : toSafeId<"entity">(parentId),
      directories: plan.directories,
      files,
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  const fileByKey = new Map<string, File>();
  for (const [index, placement] of plan.files.entries()) {
    fileByKey.set(String(index), placement.file);
  }

  const preparedUploadByFile = new Map<File, PreparedFileEntityUpload>();
  for (const preparedFile of response.data.files) {
    const file = fileByKey.get(preparedFile.key);
    if (!file) {
      throw new ClientOperationError({
        action: "prepare-dropped-folder-upload",
        message: "Prepared upload referenced an unknown file",
      });
    }
    preparedUploadByFile.set(file, {
      uploadId: preparedFile.uploadId,
      parentId: preparedFile.parentId,
      url: preparedFile.url,
      headers: preparedFile.headers,
    });
  }

  if (preparedUploadByFile.size !== plan.files.length) {
    throw new ClientOperationError({
      action: "prepare-dropped-folder-upload",
      message: "Prepared upload response did not include every file",
    });
  }

  const parentIdByFile = new Map<File, string | null>();
  for (const [file, preparedUpload] of preparedUploadByFile) {
    parentIdByFile.set(file, preparedUpload.parentId);
  }

  return {
    files: plan.files.map(({ file }) => file),
    preparedUploadByFile,
    parentIdByFile,
  };
};

const attachResponseForRetry = (error: Error, response: Response): void => {
  // The upload queue reads `Retry-After` off the raw Response on
  // 429s; preserving it keeps the rate-limit pause behaviour the
  // legacy multipart upload had.
  Object.defineProperty(error, "response", {
    value: response,
    enumerable: false,
  });
};

const abortUpload = async (
  workspaceId: string,
  uploadId: string,
): Promise<void> => {
  // Best-effort: the bucket lifecycle catches the tmp object after
  // 24h and the daily prune cleans the row, so a failed abort is
  // not fatal. We swallow errors to avoid masking the original
  // cancellation/failure with a follow-up rejection.
  await api
    .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })({ uploadId })
    .abort.post({})
    .catch(() => undefined);
};

type AbortPreparedUploadsForFilesOptions = {
  workspaceId: string;
  files: File[];
  preparedUploadForFile: (file: File) => PreparedFileEntityUpload | undefined;
};

const abortPreparedUploadsForFiles = async ({
  workspaceId,
  files,
  preparedUploadForFile,
}: AbortPreparedUploadsForFilesOptions): Promise<void> => {
  for (const file of files) {
    const preparedUpload = preparedUploadForFile(file);
    if (preparedUpload) {
      await abortUpload(workspaceId, preparedUpload.uploadId);
    }
  }
};

/**
 * Upload a single file via the presigned-S3-PUT migration. Same
 * external shape as the legacy multipart upload (throws with
 * `response` attached on failure, returns `UploadResult` on
 * success) so the surrounding `UploadQueue` integration is
 * untouched.
 *
 *   1. Compute SHA-256 of the bytes in-thread. 50 MB takes
 *      ~200–500ms on modern hardware; a Web Worker is a phase-6
 *      optimisation, not a correctness requirement.
 *   2. POST `/uploads/:wsId/presign` with the declared metadata.
 *      The API records intent in `pending_uploads`, issues a
 *      5-minute URL bound to the exact size and checksum.
 *   3. PUT directly to S3. S3 verifies the checksum at the edge;
 *      any mismatch fails with a 4xx before the API is involved.
 *   4. POST `/uploads/:wsId/:uploadId/finalize`. The API runs the
 *      claim FSM, scans, server-side promotes `tmp/` → final key,
 *      commits the entity transaction.
 *   5. On any abort/error mid-flight, POST `/abort` to mark the
 *      pending row as rejected. Re-entry to step 2 returns the
 *      cached result so accidental double-finalizes are safe.
 */
type UploadSingleFileOptions = {
  file: File;
  workspaceId: string;
  propertyId: string;
  parentId?: string | null | undefined;
  signal: AbortSignal;
};

type PrepareSingleFileEntityUploadOptions = UploadSingleFileOptions;

const prepareSingleFileEntityUpload = async ({
  file,
  workspaceId,
  propertyId,
  parentId,
  signal,
}: PrepareSingleFileEntityUploadOptions): Promise<PreparedFileEntityUpload> => {
  signal.throwIfAborted();

  // 1. SHA-256 of file bytes.
  const sha256Hex = await hashFileSha256Hex(file);

  signal.throwIfAborted();

  // 2. Presign.
  const wsClient = api.uploads({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });
  const presign = await wsClient.presign.post(
    buildEntityCreatePresignPayload({
      propertyId,
      parentId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      sha256Hex,
    }),
    { fetch: { signal } },
  );
  if (presign.error) {
    const error = toAPIError(presign.error);
    attachResponseForRetry(error, presign.response);
    throw error;
  }

  return {
    ...presign.data,
    parentId: parentId ?? null,
  };
};

type UploadPreparedFileEntityOptions = {
  file: File;
  workspaceId: string;
  preparedUpload: PreparedFileEntityUpload;
  signal: AbortSignal;
};

const uploadPreparedFileEntity = async ({
  file,
  workspaceId,
  preparedUpload,
  signal,
}: UploadPreparedFileEntityOptions): Promise<UploadResult> => {
  const { uploadId, url, headers } = preparedUpload;
  const wsClient = api.uploads({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });

  // 3. PUT to S3. S3 enforces the signed checksum + length; a
  //    mismatched body comes back as 4xx and we surface the body
  //    as the error message.
  let putResponse: Response;
  try {
    putResponse = await fetch(url, {
      method: "PUT",
      headers,
      body: file,
      signal,
    });
  } catch (error) {
    await abortUpload(workspaceId, uploadId);
    if (error instanceof Error) {
      throw error;
    }
    throw new ClientOperationError({
      action: "upload-file-to-s3",
      message: "S3 upload network error",
      cause: error,
    });
  }
  if (!putResponse.ok) {
    const detail = await putResponse.text().catch(() => "");
    const error = new ClientOperationError({
      action: "upload-file-to-s3",
      message: `S3 rejected upload (${putResponse.status}${
        detail ? `: ${detail.slice(0, 200)}` : ""
      })`,
    });
    attachResponseForRetry(error, putResponse);
    await abortUpload(workspaceId, uploadId);
    throw error;
  }

  // 4. Finalize.
  const finalize = await wsClient({ uploadId }).finalize.post(
    { queryKey: entitiesKeys.all(workspaceId) },
    { fetch: { signal } },
  );
  if (finalize.error) {
    const error = toAPIError(finalize.error);
    attachResponseForRetry(error, finalize.response);
    // Finalize owns the pending row once called. 422s are terminal
    // rejections, 409/5xx may still be in-flight or retryable.
    throw error;
  }

  const finalizedResult = finalize.data.finalizedResult;
  if (finalizedResult.type !== "entity_create") {
    // The route only ever issues `entity_create` presigns, so this
    // is a structural impossibility — narrow it explicitly so the
    // result type doesn't leak `entity_version` fields back to
    // callers that wouldn't know what to do with them.
    return panic(
      `Unexpected upload finalized as ${finalizedResult.type satisfies string}`,
    );
  }
  return {
    entityId: finalizedResult.entityId,
    fileId: finalizedResult.fileId,
    fileName: finalizedResult.fileName,
    renamed: finalizedResult.renamed,
  };
};

const uploadSingleFile = async (
  options: UploadSingleFileOptions,
): Promise<UploadResult> => {
  const preparedUpload = await prepareSingleFileEntityUpload(options);
  return await uploadPreparedFileEntity({
    file: options.file,
    workspaceId: options.workspaceId,
    preparedUpload,
    signal: options.signal,
  });
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
  parentId?: string | null | undefined;
  parentIdForFile?: (file: File) => string | null | undefined;
  preparedUploadForFile?: (file: File) => PreparedFileEntityUpload | undefined;
  onPreparedUploadFailed?: (
    file: File,
    preparedUpload: PreparedFileEntityUpload,
  ) => Promise<void> | void;
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
  const {
    files,
    workspaceId,
    propertyId,
    parentId,
    parentIdForFile,
    preparedUploadForFile,
    onPreparedUploadFailed,
    labels,
    onError,
  } = options;

  if (files.length === 0) {
    return [];
  }

  return await new Promise<UploadResult[]>((resolve) => {
    const completedFiles = new Set<File>();
    const queue = new UploadQueue<UploadResult>(async (file, signal) => {
      const preparedUpload = preparedUploadForFile?.(file);
      if (preparedUpload) {
        try {
          const result = await uploadPreparedFileEntity({
            file,
            workspaceId,
            preparedUpload,
            signal,
          });
          completedFiles.add(file);
          return result;
        } catch (error) {
          await onPreparedUploadFailed?.(file, preparedUpload);
          throw error;
        }
      }

      const fileParentId = parentIdForFile?.(file);
      const result = await uploadSingleFile({
        file,
        workspaceId,
        propertyId,
        parentId: fileParentId === undefined ? parentId : fileParentId,
        signal,
      });
      completedFiles.add(file);
      return result;
    }, MAX_PARALLEL_FILE_UPLOADS);

    const initialTotal = files.length;
    const showProgress = initialTotal > 1;

    const toastId = stellaToast.add({
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
        stellaToast.update(toastId, {
          description: labels.progress(completed, total),
        });
      }
    });

    queue.on("rate-limited", ({ retryAfterS }) => {
      stellaToast.update(toastId, {
        description: labels.rateLimited(retryAfterS),
      });
    });

    queue.on("resumed", () => {
      const { completed, total } = queue.getProgress();
      if (total > 1) {
        stellaToast.update(toastId, {
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

      if (cancelled && preparedUploadForFile) {
        const unfinishedPreparedFiles = files.filter(
          (file) => !completedFiles.has(file),
        );
        abortPreparedUploadsForFiles({
          workspaceId,
          files: unfinishedPreparedFiles,
          preparedUploadForFile,
        }).catch((error: unknown) => {
          if (error instanceof Error) {
            onError?.(error);
          }
        });
      }

      const failedNames = failed.map((f) => f.file.name);
      const failedCount = failedNames.length;
      const successCount = completed.length;

      if (cancelled) {
        stellaToast.update(toastId, {
          type: successCount > 0 || failedCount > 0 ? "warning" : "info",
          title: labels.partial(failedCount, total),
          description:
            successCount > 0 ? labels.progress(successCount, total) : undefined,
          timeout: undefined,
          actionProps: undefined,
        });
      } else if (failedCount === 0) {
        stellaToast.update(toastId, {
          type: "success",
          title: labels.uploadedSuccessfully,
          description: undefined,
          timeout: undefined,
          actionProps: undefined,
        });
      } else if (successCount > 0) {
        stellaToast.update(toastId, {
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
        stellaToast.update(toastId, {
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
        stellaToast.add({
          title: labels.renamed(renamedCount),
          type: "info",
          // Informational only — no action required from the
          // user, so dismiss after the default toast lifetime
          // instead of sticking on screen until manually closed.
          timeout: 5000,
        });
      }

      resolve(completed);
    });

    queue.enqueue(files);
  });
};

export type CreateFileEntitiesInput =
  | {
      files: File[];
      parentId?: string | null | undefined;
    }
  | {
      tree: DroppedFileTree;
      parentId?: string | null | undefined;
    };

const hasUploadInputItems = (input: CreateFileEntitiesInput): boolean => {
  if ("tree" in input) {
    return input.tree.files.length > 0 || input.tree.directoryPaths.length > 0;
  }

  return input.files.length > 0;
};

export const useCreateFileEntities = (workspaceId: string) => {
  const t = useTranslations();
  const labels = useBatchUploadLabels();
  const queryClient = useQueryClient();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const analytics = useAnalytics();
  const startWorkflow = useStartWorkflow(workspaceId);

  const ensureFileProperty = async (): Promise<string> => {
    let propertyId = properties.find((p) => p.content.type === "file")?.id;

    if (propertyId) {
      return propertyId;
    }

    const response = await api.properties({ workspaceId }).put({
      queryKey: propertiesKeys.all(workspaceId),
      name: t("workspaces.files.defaultPropertyName"),
      contentType: "file",
    });
    if (response.error) {
      throw toAPIError(response.error);
    }
    propertyId = response.data.id;
    return propertyId;
  };

  const startWorkflowForUploadedFiles = (uploaded: UploadResult[]) => {
    // Backfill AI extraction columns on the newly-uploaded entities.
    // Without this they sit blank until something else triggers a
    // workflow run; the user expects values to populate as soon as
    // the file lands. Scope to the new entities so unrelated rows
    // aren't recomputed. A workspace with no AI properties safely
    // no-ops (startWorkflow returns `skipped`).
    const newEntityIds = uploaded.map((result) => result.entityId);
    if (newEntityIds.length > 0) {
      void startWorkflow({ entityIds: newEntityIds });
    }
  };

  const { isPending, mutate } = useMutation({
    mutationFn: async (input: CreateFileEntitiesInput) => {
      const parentId = input.parentId ?? null;

      if ("tree" in input) {
        const plan = buildDroppedFolderUploadPlan(input.tree);
        const propertyId =
          plan.files.length > 0 ? await ensureFileProperty() : null;
        const preparedTree = await prepareFolderTreeUpload({
          workspaceId,
          parentId,
          propertyId,
          plan,
        });

        if (preparedTree.files.length === 0 || propertyId === null) {
          return;
        }

        const uploaded = await uploadFileEntitiesBatched({
          files: preparedTree.files,
          workspaceId,
          propertyId,
          parentId,
          parentIdForFile: (file) => preparedTree.parentIdByFile.get(file),
          preparedUploadForFile: (file) =>
            preparedTree.preparedUploadByFile.get(file),
          onPreparedUploadFailed: async (file, preparedUpload) => {
            preparedTree.preparedUploadByFile.delete(file);
            await abortUpload(workspaceId, preparedUpload.uploadId);
          },
          labels,
          onError: (error) => analytics.captureError(error),
        });
        startWorkflowForUploadedFiles(uploaded);
        return;
      }

      const uploaded = await uploadFileEntitiesBatched({
        files: input.files,
        workspaceId,
        propertyId: await ensureFileProperty(),
        parentId,
        labels,
        onError: (error) => analytics.captureError(error),
      });
      startWorkflowForUploadedFiles(uploaded);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workspacesKeys.overview(workspaceId),
      });
    },
  });

  const handleCreateFileEntities = useCallback(
    (input: CreateFileEntitiesInput) => {
      if (isPending || !hasUploadInputItems(input)) {
        return;
      }
      mutate(input);
    },
    [isPending, mutate],
  );

  return [isPending, handleCreateFileEntities] as const;
};
