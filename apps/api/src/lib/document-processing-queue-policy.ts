import { Result, TaggedError } from "better-result";

import type { documentProcessingRuns, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { requiresDurableNativeExtraction } from "@/api/lib/search/process-extraction";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const SEARCH_INDEX_FAILURE_CODE = "search_index_failed";
export const SEARCHABLE_PDF_FAILURE_CODE = "searchable_pdf_failed";
export const SEARCH_INDEX_ATTEMPT_TIMEOUT_MS = 30_000;
export const AUTOMATIC_OCR_MAX_ATTEMPTS = 5;

export type CurrentDocumentSource = {
  content: FieldContent;
  currentVersionId: SafeId<"entityVersion"> | null;
  entityReadOnly: boolean;
  fieldEntityVersionId: SafeId<"entityVersion">;
  versionDeletedAt: Date | null;
};

type OcrProjectionProvenance = {
  sourceEntityVersionId: SafeId<"entityVersion"> | null;
  sourceFieldId: SafeId<"field"> | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

type ProjectionSourceField = {
  content: FieldContent;
  entityVersionId: SafeId<"entityVersion">;
  id: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
};

export class DocumentProcessingJobError extends TaggedError(
  "DocumentProcessingJobError",
)<{
  code: string;
  message: string;
  cause?: unknown;
}> {}

export const indexDocumentProjection = async ({
  indexEntity,
  timeoutMs = SEARCH_INDEX_ATTEMPT_TIMEOUT_MS,
}: {
  indexEntity: () => Promise<void>;
  timeoutMs?: number;
}) => {
  const indexed = await Result.tryPromise({
    try: async () =>
      await withTimeout(indexEntity, {
        label: "document processing initial search index",
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(indexed)) {
    return Result.err(
      new DocumentProcessingJobError({
        code: SEARCH_INDEX_FAILURE_CODE,
        message: "Document text was stored but search indexing failed",
        cause: indexed.error,
      }),
    );
  }
  return Result.ok(undefined);
};

export const isCurrentOcrSource = ({
  run,
  source,
}: {
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  };
  source: CurrentDocumentSource | null;
}): boolean =>
  source !== null &&
  !source.entityReadOnly &&
  source.versionDeletedAt === null &&
  source.currentVersionId === run.entityVersionId &&
  source.fieldEntityVersionId === run.entityVersionId &&
  source.content.type === "file" &&
  source.content.id === run.sourceFileId &&
  source.content.sha256Hex === run.sourceSha256Hex &&
  source.content.mimeType === PDF_MIME_TYPE &&
  !source.content.encrypted;

export const isCurrentNativeExtractionSource = (
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  },
  source: CurrentDocumentSource | null,
): source is CurrentDocumentSource & {
  content: Extract<FieldContent, { type: "file" }>;
} =>
  source !== null &&
  !source.entityReadOnly &&
  source.versionDeletedAt === null &&
  source.currentVersionId === run.entityVersionId &&
  source.fieldEntityVersionId === run.entityVersionId &&
  source.content.type === "file" &&
  source.content.id === run.sourceFileId &&
  source.content.sha256Hex === run.sourceSha256Hex &&
  requiresDurableNativeExtraction(source.content);

export const isPreservableAutomaticProjection = ({
  currentEntityVersionId,
  currentWorkspaceId,
  provenance,
  sourceField,
}: {
  currentEntityVersionId: SafeId<"entityVersion">;
  currentWorkspaceId: SafeId<"workspace">;
  provenance: OcrProjectionProvenance;
  sourceField: ProjectionSourceField | null;
}): boolean => {
  const isLegacyProjection =
    provenance.sourceEntityVersionId === null &&
    provenance.sourceFieldId === null &&
    provenance.sourceFileId === null &&
    provenance.sourceSha256Hex === null;
  return (
    isLegacyProjection ||
    (provenance.sourceEntityVersionId === currentEntityVersionId &&
      provenance.sourceFieldId !== null &&
      provenance.sourceFileId !== null &&
      provenance.sourceSha256Hex !== null &&
      sourceField !== null &&
      sourceField.id === provenance.sourceFieldId &&
      sourceField.entityVersionId === currentEntityVersionId &&
      sourceField.workspaceId === currentWorkspaceId &&
      sourceField.content.type === "file" &&
      sourceField.content.id === provenance.sourceFileId &&
      sourceField.content.sha256Hex === provenance.sourceSha256Hex)
  );
};

export const shouldPreserveCurrentProjection = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

export const shouldFailStaleAutomaticOcrRun = ({
  attemptCount,
  errorCode,
  requestSource,
}: {
  attemptCount: number;
  errorCode: string | null;
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
}): boolean =>
  requestSource !== "manual" &&
  errorCode !== SEARCH_INDEX_FAILURE_CODE &&
  attemptCount >= AUTOMATIC_OCR_MAX_ATTEMPTS;

export const classifyOcrProjectionSource = ({
  run,
  source,
  workspaceStatus,
}: {
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  };
  source: CurrentDocumentSource | null;
  workspaceStatus: (typeof workspaces.$inferSelect)["status"] | undefined;
}): "current" | "source_superseded" | "workspace_unavailable" => {
  if (workspaceStatus !== "active") {
    return "workspace_unavailable";
  }
  return isCurrentOcrSource({ run, source }) ? "current" : "source_superseded";
};

export const classifyOcrWorkspaceDispatch = ({
  requestSource,
  workspaceStatus,
}: {
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
  workspaceStatus: (typeof workspaces.$inferSelect)["status"] | undefined;
}): "available" | "deferred" | "workspace_unavailable" => {
  if (workspaceStatus === "active") {
    return "available";
  }
  if (workspaceStatus === "deleting" && requestSource === "manual") {
    return "deferred";
  }
  return "workspace_unavailable";
};

export const requiresOcrPolicy = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

export const ownsPromotedManualOcrClaim = ({
  claimToken,
  run,
}: {
  claimToken: string;
  run:
    | Pick<
        typeof documentProcessingRuns.$inferSelect,
        "claimedBy" | "requestSource" | "status"
      >
    | undefined;
}): boolean =>
  run?.claimedBy === claimToken &&
  run.requestSource === "manual" &&
  run.status === "running";
