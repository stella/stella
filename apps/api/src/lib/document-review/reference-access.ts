/**
 * Reference text is scoped to the matters the reader can access.
 *
 * A run may pin references from matters other than its own. Creation requires
 * the author to hold every one of them, but a later reader need not: matters
 * are shared and unshared independently of the run they were compared into,
 * and the finding rows carry the reference's verbatim passages under the
 * target matter's id.
 *
 * The pinned basis records which matter each reference field came from, so the
 * reader's own membership decides, per reference, whether its passages are
 * returned. Scoping happens on the payload, which is the single place the API
 * response, the history list and the issues-table export read reference text
 * from.
 */

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";

/** Scope one finding payload to the references the reader may still read. */
export type ReferenceScope = (
  payload: DocumentReviewFindingPayload,
) => DocumentReviewFindingPayload;

type CreateReferenceScopeArgs = {
  basis: DocumentReviewRunBasis;
  accessibleWorkspaceIds: ReadonlySet<string>;
};

/** The matters a run's references were pinned from, deduplicated. The run's
 *  own matter is authorized by the handler and is not necessarily among them. */
export const basisReferenceWorkspaceIds = (
  basis: DocumentReviewRunBasis,
): SafeId<"workspace">[] => [
  ...new Set(basis.references.map((reference) => reference.workspaceId)),
];

export const createReferenceScope = ({
  basis,
  accessibleWorkspaceIds,
}: CreateReferenceScopeArgs): ReferenceScope => {
  const readableFieldIds = new Set(
    basis.references
      .filter((reference) => accessibleWorkspaceIds.has(reference.workspaceId))
      .map((reference) => reference.fileFieldId),
  );
  return (payload) => {
    // A position graded against an authored standard cites no reference
    // document, so there is nothing here to scope.
    const referenceCitations = payload.finding.referenceCitations;
    if (referenceCitations === undefined) {
      return payload;
    }
    const readable = referenceCitations.filter((group) =>
      readableFieldIds.has(group.fileFieldId),
    );
    return readable.length === referenceCitations.length
      ? payload
      : { finding: { ...payload.finding, referenceCitations: readable } };
  };
};

/**
 * Re-read the pinned reference matters through the caller's own scoped
 * transaction: row security returns only the ones the caller can still read,
 * so an unpinned or unshared matter fails closed to "no reference text".
 */
export const resolveReferenceScope = async (
  safeDb: SafeDb,
  basis: DocumentReviewRunBasis,
) => {
  const workspaceIds = basisReferenceWorkspaceIds(basis);
  const accessible = await safeDb(async (tx) =>
    workspaceIds.length === 0
      ? []
      : await tx.query.workspaces.findMany({
          where: { id: { in: workspaceIds } },
          columns: { id: true },
          limit: workspaceIds.length,
        }),
  );
  return accessible.map((rows) =>
    createReferenceScope({
      basis,
      accessibleWorkspaceIds: new Set(rows.map((row) => row.id)),
    }),
  );
};
