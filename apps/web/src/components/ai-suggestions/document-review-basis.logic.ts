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

export type ReviewBasis =
  | { type: "playbook"; playbookId: string }
  | { type: "references"; references: ReferenceFile[] }
  | {
      type: "combined";
      playbookId: string;
      references: ReferenceFile[];
    };

type CreateReviewBasisArgs = {
  playbookId: string | null;
  references: readonly ReferenceFile[];
};

export const createReviewBasis = ({
  playbookId,
  references,
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
    return { type: "combined", playbookId, references: uniqueReferences };
  }
  if (playbookId !== null) {
    return { type: "playbook", playbookId };
  }
  if (uniqueReferences.length > 0) {
    return { type: "references", references: uniqueReferences };
  }
  return null;
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
