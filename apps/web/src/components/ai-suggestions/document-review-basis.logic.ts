export type ReferenceFile = {
  /** The matter the document lives in; may differ from the reviewed one. */
  workspaceId: string;
  /** That matter's name, or `null` for a document picked from the matter
   *  being reviewed, where naming it would only repeat the page. */
  workspaceName: string | null;
  entityId: string;
  fileFieldId: string;
  name: string;
  fileName: string;
};

/**
 * Whose interest a reference comparison is judged for. Mirrors the API's
 * `REVIEW_PERSPECTIVES`; the request body is typed against the API, so a
 * value missing here fails to compile at the call site.
 */
export const REVIEW_PERSPECTIVES = ["buyer", "seller", "neutral"] as const;
export type ReviewPerspective = (typeof REVIEW_PERSPECTIVES)[number];

export type ReviewBasis =
  | { type: "playbook"; playbookId: string }
  | {
      type: "references";
      references: ReferenceFile[];
      perspective: ReviewPerspective;
    }
  | {
      type: "combined";
      playbookId: string;
      references: ReferenceFile[];
      perspective: ReviewPerspective;
    };

type CreateReviewBasisArgs = {
  playbookId: string | null;
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
};

export const createReviewBasis = ({
  playbookId,
  references,
  perspective,
}: CreateReviewBasisArgs): ReviewBasis | null => {
  const uniqueReferences: ReferenceFile[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.entityId}:${reference.fileFieldId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueReferences.push(reference);
  }

  if (playbookId !== null && uniqueReferences.length > 0) {
    return {
      type: "combined",
      playbookId,
      references: uniqueReferences,
      perspective,
    };
  }
  if (playbookId !== null) {
    return { type: "playbook", playbookId };
  }
  if (uniqueReferences.length > 0) {
    return { type: "references", references: uniqueReferences, perspective };
  }
  return null;
};

/** The side a basis judges its references for; `neutral` for a playbook-only
 *  basis, which compares against nothing and so has no side to take. */
export const perspectiveFromBasis = (basis: ReviewBasis): ReviewPerspective => {
  switch (basis.type) {
    case "references":
    case "combined":
      return basis.perspective;
    case "playbook":
      return "neutral";
    default: {
      basis satisfies never;
      return "neutral";
    }
  }
};

export const playbookIdFromBasis = (basis: ReviewBasis): string | null => {
  switch (basis.type) {
    case "playbook":
    case "combined":
      return basis.playbookId;
    case "references":
      return null;
    default: {
      basis satisfies never;
      return null;
    }
  }
};

export const referencesFromBasis = (
  basis: ReviewBasis,
): readonly ReferenceFile[] => {
  switch (basis.type) {
    case "references":
    case "combined":
      return basis.references;
    case "playbook":
      return [];
    default: {
      basis satisfies never;
      return [];
    }
  }
};
