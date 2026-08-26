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
 *  when stated, its name. Proposed by the position pass, chosen by the
 *  lawyer. */
export type ReviewParty = { role: string; name: string | null };

/** Something the reference document covers that the position pass read but
 *  deliberately did not turn into a position: `subject` names it, `reason`
 *  says in a few words why it is not comparable. */
export type ReviewSkippedTerm = { subject: string; reason: string };

/**
 * Whose interest a comparison is judged for: one of the target's parties, or
 * no side. Mirrors the API's `ReviewPerspective`; the request body is typed
 * against the API, so a drift fails to compile at the call site.
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

/**
 * What the reviewer assembled before any position list exists: a playbook (or
 * none), the reference documents to derive positions from (or none), and the
 * side the run is judged for.
 *
 * Deliberately one record rather than a union. A playbook run and a
 * reference-derived run differ only in where a position's standard came from,
 * which the position itself says (`standard.source`); a second discriminator
 * here would put the same fact in two places.
 */
export type ReviewSetup = {
  playbookId: string | null;
  references: ReferenceFile[];
  perspective: ReviewPerspective;
};

export const emptyReviewSetup = (): ReviewSetup => ({
  playbookId: null,
  references: [],
  perspective: NEUTRAL_PERSPECTIVE,
});

/** Whether a setup names anything to measure the document against. Nothing
 *  chosen means there is no review to start. */
export const isReviewSetupRunnable = ({
  playbookId,
  references,
}: ReviewSetup): boolean => playbookId !== null || references.length > 0;
