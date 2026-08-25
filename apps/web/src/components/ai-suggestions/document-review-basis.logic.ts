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

/** A party to the reviewed document, by the role the document gives it and,
 *  when stated, its name. Proposed by the topic pass, chosen by the lawyer. */
export type ReviewParty = { role: string; name: string | null };

/**
 * Whose interest a reference comparison is judged for: one of the target's
 * parties, or no side. Mirrors the API's `ReviewPerspective`; the request
 * body is typed against the API, so a drift fails to compile at the call
 * site.
 */
export type ReviewPerspective =
  | { type: "neutral" }
  | ({ type: "party" } & ReviewParty);

export const NEUTRAL_PERSPECTIVE: ReviewPerspective = { type: "neutral" };

/** Preserve the editable role exactly while normalising the perspective sent
 *  to the review contract. */
export const customPerspectiveInput = (rawRole: string) => {
  const role = rawRole.trim();
  const perspective: ReviewPerspective =
    role.length === 0
      ? NEUTRAL_PERSPECTIVE
      : { type: "party", role, name: null };
  return { rawRole, perspective };
};

/** Whether two perspectives name the same side. */
export const isSamePerspective = (
  a: ReviewPerspective,
  b: ReviewPerspective,
): boolean =>
  a.type === "neutral"
    ? b.type === "neutral"
    : b.type === "party" && a.role === b.role && a.name === b.name;

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
      return NEUTRAL_PERSPECTIVE;
    default: {
      basis satisfies never;
      return NEUTRAL_PERSPECTIVE;
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
