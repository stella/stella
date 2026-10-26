import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { DOCUMENT_UPLOAD_PUT_TIMEOUT_MS } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import { stellaToast } from "@stll/ui/toast";

import { useStartWorkflow } from "@/components/workspaces/hooks/use-start-workflow";
import { MAX_PARALLEL_FILE_UPLOADS } from "@/consts";
import type { DroppedFileTree } from "@/hooks/external-file-drop.logic";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import {
  hashActiveUploadFile,
  withActiveUpload,
} from "@/lib/files/active-uploads";
import {
  ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT,
  preflightAttachedTemplateUpload,
} from "@/lib/files/attached-template-upload-preflight";
import { resolveDocumentReferenceMatches } from "@/lib/files/document-reference-queries";
import { useDocumentReferenceUploadStore } from "@/lib/files/document-reference-upload-store";
import { deriveIdempotentRequest } from "@/lib/idempotency/idempotent-subrequest";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { UploadQueue } from "@/lib/upload-queue";
import {
  buildDroppedFolderUploadPlan,
  type DroppedFolderUploadPlan,
  folderReservableFiles,
} from "@/lib/workspaces/mutations/create-file-tree-upload.logic";
import {
  buildEntityCreatePresignPayload,
  entityCreateLocalInvalidationKeys,
} from "@/lib/workspaces/mutations/create-file-upload-payload.logic";
import {
  createFileEntityUploader,
  type FileEntityUploadGrant,
} from "@/lib/workspaces/mutations/file-entity-upload.logic";
import { showUploadFailureToast } from "@/lib/workspaces/mutations/upload-failure-toast";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";

type UploadResult = {
  entityId: string;
  fileId: string;
  fileName: string;
  renamed: boolean;
};

type PreparedFileEntityUpload = FileEntityUploadGrant & {
  parentId: string | null;
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
  const reservable = folderReservableFiles(plan);
  const files = [];
  for (const { key, placement } of reservable) {
    files.push({
      key,
      parentKey: placement.parentKey,
      name: placement.file.name,
      mimeType: placement.file.type || "application/octet-stream",
      size: placement.file.size,
      sha256Hex: await hashActiveUploadFile(placement.file),
    });
  }

  const response = await api
    .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["entity-create"].tree.post({
      propertyId: propertyId ? toSafeId<"property">(propertyId) : null,
      parentId: parentId === null ? null : toSafeId<"entity">(parentId),
      directories: plan.directories,
      files,
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  const fileByKey = new Map<string, File>();
  for (const { key, placement } of reservable) {
    fileByKey.set(key, placement.file);
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

  if (preparedUploadByFile.size !== reservable.length) {
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
  try {
    // SAFETY: best-effort abort; the bucket lifecycle rule and daily
    // prune already reclaim the tmp object and row within 24h, so a
    // failed abort here is not fatal and has no user-facing outcome.
    // oxlint-disable-next-line require-api-error-check/require-api-error-check
    await api
      .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })({
        uploadId,
      })
      .abort.post({});
  } catch {
    // Intentionally swallowed; see comment above.
  }
};

/**
 * Upload a single file via the presigned-S3-PUT migration. Same
 * external shape as the legacy multipart upload (throws with
 * `response` attached on failure, returns `UploadResult` on
 * success) so the surrounding `UploadQueue` integration is
 * untouched.
 *
 *   1. Compute SHA-256 in one pass of bounded chunks, counted
 *      as an active upload while the file is read.
 *   2. POST `/uploads/:wsId/presign` with the declared metadata.
 *      The API records intent in `pending_uploads`, issues a
 *      5-minute URL bound to the exact size and checksum.
 *   3. PUT directly to S3. S3 verifies the checksum at the edge;
 *      any mismatch fails with a 4xx before the API is involved.
 *   4. POST `/uploads/:wsId/:uploadId/finalize`. The API runs the
 *      claim FSM, scans, server-side promotes `tmp/` → final key,
 *      commits the entity transaction.
 *   5. A failed PUT POSTs `/abort` to mark the pending row as
 *      rejected; the next attempt reserves anew. A finalize that may
 *      still complete is retried on the same upload id (see
 *      `createFileEntityUploader`), so a lost finalize response
 *      replays the committed result instead of uploading again.
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
  const sha256Hex = await hashActiveUploadFile(file);

  signal.throwIfAborted();

  // 2. Presign.
  const wsClient = api.uploads({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });
  const presign = await wsClient.presign.post(
    readQueryResult(
      buildEntityCreatePresignPayload({
        propertyId,
        parentId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        sha256Hex,
      }),
    ),
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

type PutFileEntityOptions = {
  file: File;
  workspaceId: string;
  grant: FileEntityUploadGrant;
  signal: AbortSignal;
};

const putFileEntity = async ({
  file,
  workspaceId,
  grant,
  signal,
}: PutFileEntityOptions): Promise<void> => {
  const { uploadId, url, headers } = grant;

  // 3. PUT to S3. S3 enforces the signed checksum + length; a
  //    mismatched body comes back as 4xx and we surface the body
  //    as the error message.
  let putResponse: Response;
  try {
    putResponse = await fetchWithTimeout(url, {
      method: "PUT",
      headers,
      body: file,
      signal,
      timeout: { type: "idle", ms: DOCUMENT_UPLOAD_PUT_TIMEOUT_MS },
    });
  } catch (error) {
    // Best-effort cleanup: abortUpload swallows its own errors and its
    // result is never used, so don't block surfacing the original
    // network error on it completing.
    detached(
      abortUpload(workspaceId, uploadId),
      "use-create-file-entities.abort-upload",
    );
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
    const error = toAPIError({
      status: putResponse.status,
      value: await putResponse.text().catch(() => undefined),
    });
    attachResponseForRetry(error, putResponse);
    await abortUpload(workspaceId, uploadId);
    throw error;
  }
};

type FinalizeFileEntityOptions = {
  workspaceId: string;
  uploadId: string;
  signal: AbortSignal;
};

const finalizeFileEntity = async ({
  workspaceId,
  uploadId,
  signal,
}: FinalizeFileEntityOptions): Promise<UploadResult> => {
  // 4. Finalize. Finalize owns the pending row once called; whether a
  //    failure may still complete on this upload id is decided by
  //    `finalizeFailureKeepsUpload`.
  const finalize = await api
    .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })({ uploadId })
    .finalize.post(undefined, { fetch: { signal } });
  if (finalize.error) {
    const error = toAPIError(finalize.error);
    attachResponseForRetry(error, finalize.response);
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
  additionalFailures: (count: number) => string;
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
    additionalFailures: (count) => t("chat.historyContext.unnamed", { count }),
  };
};

type BatchUploadOptions = {
  files: File[];
  workspaceId: string;
  propertyId: string;
  parentId?: string | null | undefined;
  parentIdForFile?: (file: File) => string | null | undefined;
  /**
   * Reservations made ahead for some files (a dropped folder). Each is used
   * by its file's first attempt and removed; a cancel aborts the unused ones.
   */
  preparedUploads?: Map<File, PreparedFileEntityUpload>;
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
  if (options.files.length === 0) {
    return [];
  }

  return await withActiveUpload(async () => await runUploadBatch(options));
};

const runUploadBatch = async ({
  files,
  workspaceId,
  propertyId,
  parentId,
  parentIdForFile,
  preparedUploads,
  labels,
  onError,
}: BatchUploadOptions): Promise<UploadResult[]> =>
  await new Promise<UploadResult[]>((resolve) => {
    const uploader = createFileEntityUploader<UploadResult>({
      reserve: async (file, signal) => {
        const preparedUpload = preparedUploads?.get(file);
        if (preparedUpload) {
          preparedUploads?.delete(file);
          return preparedUpload;
        }
        const fileParentId = parentIdForFile?.(file);
        return await prepareSingleFileEntityUpload({
          file,
          workspaceId,
          propertyId,
          parentId: fileParentId === undefined ? parentId : fileParentId,
          signal,
        });
      },
      put: async (file, grant, signal) =>
        await putFileEntity({ file, workspaceId, grant, signal }),
      finalize: async (uploadId, signal) =>
        await finalizeFileEntity({ workspaceId, uploadId, signal }),
      abort: async (uploadId) => await abortUpload(workspaceId, uploadId),
    });
    const queue = new UploadQueue<UploadResult>(
      async (file, signal) =>
        readQueryResult(await uploader.upload(file, signal)),
      MAX_PARALLEL_FILE_UPLOADS,
    );

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

      if (cancelled) {
        const unusedPreparedUploads = preparedUploads
          ? [...preparedUploads.values()]
          : [];
        preparedUploads?.clear();
        detached(
          (async () => {
            for (const preparedUpload of unusedPreparedUploads) {
              await abortUpload(workspaceId, preparedUpload.uploadId);
            }
            await uploader.abortStaged();
          })(),
          "use-create-file-entities.abort-cancelled-uploads",
        );
      }

      const failedCount = failed.length;
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
        showUploadFailureToast({
          toastId,
          title: labels.partial(failedCount, total),
          type: "warning",
          failures: failed,
          labels: {
            reasonFallback: labels.uploadFailed,
            additionalFailures: labels.additionalFailures,
            retryFailed: labels.retryFailed,
          },
          onRetry: () => queue.retryFailed(),
        });
      } else {
        showUploadFailureToast({
          toastId,
          title: labels.uploadFailed,
          type: "error",
          failures: failed,
          labels: {
            reasonFallback: labels.uploadFailed,
            additionalFailures: labels.additionalFailures,
            retryFailed: labels.retryFailed,
          },
          onRetry: () => queue.retryFailed(),
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

/**
 * Whether these files still owe the user the question "is this a new version
 * of a document you already have?".
 */
export const REFERENCE_CHECK = {
  ask: "ask",
  /** The caller has already put the question and acted on the answer. */
  skip: "skip",
} as const;

type ReferenceCheckMode =
  (typeof REFERENCE_CHECK)[keyof typeof REFERENCE_CHECK];

type CreateFileEntitiesOptions = {
  parentId?: string | null | undefined;
  referenceCheck?: ReferenceCheckMode | undefined;
};

export type CreateFileEntitiesInput =
  | ({ files: File[] } & CreateFileEntitiesOptions)
  | ({ tree: DroppedFileTree } & CreateFileEntitiesOptions);

const hasUploadInputItems = (input: CreateFileEntitiesInput): boolean => {
  if ("tree" in input) {
    return input.tree.files.length > 0 || input.tree.directoryPaths.length > 0;
  }

  return input.files.length > 0;
};

const uploadInputFiles = (input: CreateFileEntitiesInput): File[] =>
  "tree" in input ? input.tree.files.map(({ file }) => file) : [...input.files];

const withUploadInputFileReplacements = (
  input: CreateFileEntitiesInput,
  replacements: ReadonlyMap<File, File>,
): CreateFileEntitiesInput => {
  if ("tree" in input) {
    return {
      tree: {
        files: input.tree.files.map(({ file, pathSegments }) => ({
          file: replacements.get(file) ?? file,
          pathSegments,
        })),
        directoryPaths: input.tree.directoryPaths,
      },
      parentId: input.parentId,
      referenceCheck: input.referenceCheck,
    };
  }

  return {
    files: input.files.map((file) => replacements.get(file) ?? file),
    parentId: input.parentId,
    referenceCheck: input.referenceCheck,
  };
};

/**
 * The same upload minus the files the user chose to file as versions. A
 * dropped folder keeps its directories: they are created whether or not any
 * file lands inside them.
 */
const withoutUploadInputFiles = (
  input: CreateFileEntitiesInput,
  excluded: ReadonlySet<File>,
): CreateFileEntitiesInput => {
  if ("tree" in input) {
    return {
      tree: {
        files: input.tree.files.filter(({ file }) => !excluded.has(file)),
        directoryPaths: input.tree.directoryPaths,
      },
      parentId: input.parentId ?? null,
      referenceCheck: REFERENCE_CHECK.skip,
    };
  }

  return {
    files: input.files.filter((file) => !excluded.has(file)),
    parentId: input.parentId ?? null,
    referenceCheck: REFERENCE_CHECK.skip,
  };
};

export const useCreateFileEntities = (workspaceId: string) => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const labels = useBatchUploadLabels();
  const queryClient = useQueryClient();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const analytics = useAnalytics();
  const startWorkflow = useStartWorkflow(workspaceId);
  const askAboutReferencedFiles = useDocumentReferenceUploadStore(
    (store) => store.ask,
  );

  const ensureFileProperty = async (
    request: IdempotentRequest,
  ): Promise<string> => {
    let propertyId = properties.find((p) => p.content.type === "file")?.id;

    if (propertyId) {
      return propertyId;
    }

    const response = await api.properties({ workspaceId }).put(
      {
        name: t("common.documents"),
        contentType: "file",
      },
      await deriveIdempotentRequest(request, "property"),
    );
    propertyId = unwrapApiResponse(response).id;
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
      detached(
        startWorkflow({ entityIds: newEntityIds }),
        "use-create-file-entities.start-workflow",
      );
    }
  };

  const { isPending, mutate } = useIdempotentMutation({
    idempotencyScope: workspaceId,
    mutationFn: async (input: CreateFileEntitiesInput, request) => {
      const parentId = input.parentId ?? null;

      if ("tree" in input) {
        const plan = buildDroppedFolderUploadPlan(input.tree);
        const propertyId =
          plan.files.length > 0 ? await ensureFileProperty(request) : null;
        const uploaded = await withActiveUpload(async () => {
          const preparedTree = await prepareFolderTreeUpload({
            workspaceId,
            parentId,
            propertyId,
            plan,
          });

          if (preparedTree.files.length === 0 || propertyId === null) {
            return [];
          }

          return await uploadFileEntitiesBatched({
            files: preparedTree.files,
            workspaceId,
            propertyId,
            parentId,
            parentIdForFile: (file) => preparedTree.parentIdByFile.get(file),
            preparedUploads: preparedTree.preparedUploadByFile,
            labels,
            onError: (error) =>
              analytics.captureError(error, {
                fingerprintKey: "useCreateFileEntities.mutationFn:failure",
                scope: {
                  type: "handler",
                  handlerId: "useCreateFileEntities.mutationFn:failure",
                },
              }),
          });
        });
        startWorkflowForUploadedFiles(uploaded);
        return;
      }

      const uploaded = await uploadFileEntitiesBatched({
        files: input.files,
        workspaceId,
        propertyId: await ensureFileProperty(request),
        parentId,
        labels,
        onError: (error) =>
          analytics.captureError(error, {
            fingerprintKey: "useCreateFileEntities.mutationFn:failure-2",
            scope: {
              type: "handler",
              handlerId: "useCreateFileEntities.mutationFn:failure-2",
            },
          }),
      });
      startWorkflowForUploadedFiles(uploaded);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCreateFileEntities:failure",
        scope: { type: "handler", handlerId: "useCreateFileEntities:failure" },
      });
    },
    onSettled: () => {
      detached(
        Promise.all(
          entityCreateLocalInvalidationKeys(workspaceId).map(
            async (key) =>
              await queryClient.invalidateQueries({ queryKey: key }),
          ),
        ),
        "use-create-file-entities.invalidate",
      );
    },
  });

  /**
   * Ask about files that turned out to be versions of documents stella
   * already holds, then upload what is left as new documents.
   *
   * The reference lives in the file itself, so this is the one place that can
   * tell a re-filed document from a duplicate — before any bytes are sent.
   * Non-DOCX files never reach a lookup, so an upload of scans or images is
   * not delayed by this at all.
   */
  const createFileEntitiesAfterReferenceCheck = async (
    input: CreateFileEntitiesInput,
  ): Promise<void> => {
    const referenced = await resolveDocumentReferenceMatches({
      queryClient,
      files: uploadInputFiles(input),
      organizationId: activeOrganizationId,
      onError: (error) =>
        analytics.captureError(error, {
          fingerprintKey:
            "useCreateFileEntities.createFileEntitiesAfterReferenceCheck:failure",
          scope: {
            type: "handler",
            handlerId:
              "useCreateFileEntities.createFileEntitiesAfterReferenceCheck:failure",
          },
        }),
    });

    if (referenced.length === 0) {
      mutate(input);
      return;
    }

    askAboutReferencedFiles({
      referenced,
      onResolved: (newDocumentFiles) => {
        const keptAsNewDocuments = new Set(newDocumentFiles);
        const filedAsVersions = new Set(
          referenced
            .map(({ file }) => file)
            .filter((file) => !keptAsNewDocuments.has(file)),
        );
        const remaining = withoutUploadInputFiles(input, filedAsVersions);
        if (hasUploadInputItems(remaining)) {
          mutate(remaining);
        }
      },
      onCancelled: () => {
        // Deliberate: the user declined the whole batch, versions included.
      },
    });
  };

  const continueAfterAttachedTemplateCheck = (
    input: CreateFileEntitiesInput,
  ) => {
    if (input.referenceCheck === REFERENCE_CHECK.skip) {
      mutate(input);
      return;
    }
    detached(
      createFileEntitiesAfterReferenceCheck(input),
      "use-create-file-entities.reference-check",
    );
  };

  const createFileEntitiesAfterAttachedTemplateCheck = async (
    input: CreateFileEntitiesInput,
  ): Promise<void> => {
    const preflight = await preflightAttachedTemplateUpload(
      uploadInputFiles(input),
    );
    switch (preflight.type) {
      case ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.cancelled:
        return;
      case ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.ready:
        continueAfterAttachedTemplateCheck(
          withUploadInputFileReplacements(input, preflight.replacements),
        );
        return;
      default:
        preflight satisfies never;
        return panic(
          `Unhandled attached-template preflight: ${String(preflight)}`,
        );
    }
  };

  const handleCreateFileEntities = (input: CreateFileEntitiesInput) => {
    if (!hasUploadInputItems(input)) {
      return;
    }
    detached(
      createFileEntitiesAfterAttachedTemplateCheck(input),
      "use-create-file-entities.attached-template-check",
    );
  };

  return [isPending, handleCreateFileEntities] as const;
};
