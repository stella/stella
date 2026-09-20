import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { PlaybookScope } from "@/api/lib/workflow/playbook-positions";

// Named so `save_playbook` can recognize this refusal and add the next step
// an agent needs; the HTTP message itself is unchanged.
export const DOCUMENT_TYPE_NOT_FOUND_MESSAGE =
  "Document type not found in this organization";

type AssertPlaybookDocumentTypeArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  scope: PlaybookScope | undefined;
};

/**
 * A playbook scoped to a document type must name one of the organization's
 * own: the key gates which documents a run grades, so a key from nowhere
 * would scope the playbook to nothing.
 */
export const assertPlaybookDocumentType = async ({
  safeDb,
  organizationId,
  scope,
}: AssertPlaybookDocumentTypeArgs): Promise<
  Result<void, SafeDbError | HandlerError>
> => {
  const documentTypeKey = scope?.documentTypeKey;
  if (documentTypeKey === undefined) {
    return Result.ok(undefined);
  }
  const documentType = await safeDb((tx) =>
    tx.query.documentTypes.findFirst({
      where: {
        organizationId: { eq: organizationId },
        key: { eq: documentTypeKey },
      },
      columns: { id: true },
    }),
  );
  if (Result.isError(documentType)) {
    return Result.err(documentType.error);
  }
  if (!documentType.value) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE,
      }),
    );
  }
  return Result.ok(undefined);
};
