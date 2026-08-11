import { Result } from "better-result";

import type { FieldContent } from "@/api/db/schema-validators";
import type { DocumentReviewRef } from "@/api/handlers/document-reviews/schemas";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type ReviewEntityRow = {
  id: SafeId<"entity">;
  currentVersion: {
    id: SafeId<"entityVersion">;
    fields: {
      id: SafeId<"field">;
      content: FieldContent;
    }[];
  } | null;
};

export type ResolvedReviewDocument = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  file: ResolvedFile;
};

type ResolveReviewSelectionArgs = {
  target: DocumentReviewRef;
  references: readonly DocumentReviewRef[];
  entities: readonly ReviewEntityRow[];
};

const selectionKey = ({ entityId, fileFieldId }: DocumentReviewRef): string =>
  `${entityId}:${fileFieldId}`;

const resolveOne = (
  ref: DocumentReviewRef,
  entityById: ReadonlyMap<SafeId<"entity">, ReviewEntityRow>,
): Result<ResolvedReviewDocument, HandlerError> => {
  const entity = entityById.get(ref.entityId);
  const currentVersion = entity?.currentVersion;
  if (!entity || !currentVersion) {
    return Result.err(
      new HandlerError({ status: 404, message: "Document not found" }),
    );
  }
  const field = currentVersion.fields.find(
    (candidate) => candidate.id === ref.fileFieldId,
  );
  if (field?.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 404, message: "Document not found" }),
    );
  }
  if (field.content.mimeType !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Reference comparison currently supports DOCX files only.",
      }),
    );
  }

  return Result.ok({
    entityId: entity.id,
    entityVersionId: currentVersion.id,
    file: {
      fileFieldId: field.id,
      fileId: field.content.id,
      mimeType: field.content.mimeType,
      sha256Hex: field.content.sha256Hex,
      encrypted: field.content.encrypted,
      // Reference comparison requires folio block identities even when a PDF
      // derivative exists; force the canonical DOCX preparation path.
      pdfFileId: null,
    },
  });
};

export const resolveReviewSelection = ({
  target,
  references,
  entities,
}: ResolveReviewSelectionArgs): Result<
  {
    target: ResolvedReviewDocument;
    references: ResolvedReviewDocument[];
  },
  HandlerError
> => {
  const targetKey = selectionKey(target);
  const seen = new Set<string>();
  for (const reference of references) {
    const key = selectionKey(reference);
    if (key === targetKey) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The target document cannot also be a reference.",
        }),
      );
    }
    if (seen.has(key)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Reference documents must be unique.",
        }),
      );
    }
    seen.add(key);
  }

  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const resolvedTarget = resolveOne(target, entityById);
  if (Result.isError(resolvedTarget)) {
    return Result.err(resolvedTarget.error);
  }

  const resolvedReferences: ResolvedReviewDocument[] = [];
  for (const reference of references) {
    const resolved = resolveOne(reference, entityById);
    if (Result.isError(resolved)) {
      return Result.err(resolved.error);
    }
    resolvedReferences.push(resolved.value);
  }

  return Result.ok({
    target: resolvedTarget.value,
    references: resolvedReferences,
  });
};
