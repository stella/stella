import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError } from "@/api/db/safe-db";
import { PLAYBOOK_DOCUMENT_TYPE_CONSTRAINT } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import type { PlaybookScope } from "@/api/lib/workflow/playbook-positions";

// Named so `save_playbook` can recognize this refusal and add the next step
// an agent needs; the HTTP message itself is unchanged.
export const DOCUMENT_TYPE_NOT_FOUND_MESSAGE =
  "Document type not found in this organization";

type AssertPlaybookDocumentTypeArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  scope: PlaybookScope | undefined;
};

/**
 * A playbook scoped to a document type must name one of the organization's
 * own: the key gates which documents a run grades, so a key from nowhere
 * would scope the playbook to nothing.
 */
export const assertPlaybookDocumentType = async ({
  tx,
  organizationId,
  scope,
}: AssertPlaybookDocumentTypeArgs): Promise<Result<void, HandlerError>> => {
  const documentTypeKey = scope?.documentTypeKey;
  if (documentTypeKey === undefined) {
    return Result.ok(undefined);
  }
  const documentType = await tx.query.documentTypes.findFirst({
    where: {
      organizationId: { eq: organizationId },
      key: { eq: documentTypeKey },
    },
    columns: { id: true },
  });
  if (!documentType) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE,
        retryable: false,
      }),
    );
  }
  return Result.ok(undefined);
};

// The FK also protects writes which do not perform the friendly pre-check,
// and a type deleted after that read. Preserve unrelated constraint errors.
export const mapPlaybookDocumentTypeError = (
  error: SafeDbError | HandlerError,
) =>
  isPgConstraintError(
    error,
    PG_ERROR.FOREIGN_KEY_VIOLATION,
    PLAYBOOK_DOCUMENT_TYPE_CONSTRAINT,
  )
    ? new HandlerError({
        status: 400,
        message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE,
        retryable: false,
      })
    : error;
