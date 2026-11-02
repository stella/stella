/** Inspector view kind for one provision of a consolidated statute. */
export const PROVISION_VIEW = "statute-provision";

/**
 * What the view needs to name the provision and to read about it. Every
 * field is a plain value, so the payload survives the inspector store's
 * structured-clone boundary and can be validated when it comes back.
 */
export type ProvisionViewPayload = {
  /** The consolidation the provision was opened from. */
  documentId: string;
  /** The work's own identifier, the key its incoming citations are filed under. */
  eli: string;
  jurisdiction: string;
  /** The provision heading's anchor in the statute text. */
  anchorId: string;
  /**
   * The subdivision to land on and flash (`par_90-odst_5`), when the opener
   * cited one; the heading itself otherwise.
   */
  highlightAnchorId?: string | undefined;
  /** The heading's own text, e.g. `§ 47`. */
  provisionLabel: string;
  statuteTitle: string;
  /** ISO date the consolidation entered into force, or null when unknown. */
  versionValidFrom: string | null;
  /**
   * Consolidations of the work as the opener knew them, and one when it
   * never read the list. The view reads it and counts from there.
   */
  versionCount: number;
  decisionContext?:
    | {
        court: string;
        caseNumber: string;
        appliedDocumentId: string;
      }
    | undefined;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isProvisionDecisionContext = (
  value: unknown,
): value is NonNullable<ProvisionViewPayload["decisionContext"]> =>
  typeof value === "object" &&
  value !== null &&
  "court" in value &&
  isNonEmptyString(value.court) &&
  "caseNumber" in value &&
  isNonEmptyString(value.caseNumber) &&
  "appliedDocumentId" in value &&
  isNonEmptyString(value.appliedDocumentId);

export const isProvisionViewPayload = (
  value: unknown,
): value is ProvisionViewPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    (!("decisionContext" in value) ||
      value.decisionContext === undefined ||
      isProvisionDecisionContext(value.decisionContext)) &&
    "documentId" in value &&
    isNonEmptyString(value.documentId) &&
    "eli" in value &&
    isNonEmptyString(value.eli) &&
    "jurisdiction" in value &&
    isNonEmptyString(value.jurisdiction) &&
    "anchorId" in value &&
    isNonEmptyString(value.anchorId) &&
    (!("highlightAnchorId" in value) ||
      value.highlightAnchorId === undefined ||
      isNonEmptyString(value.highlightAnchorId)) &&
    "provisionLabel" in value &&
    typeof value.provisionLabel === "string" &&
    "statuteTitle" in value &&
    typeof value.statuteTitle === "string" &&
    "versionValidFrom" in value &&
    (value.versionValidFrom === null ||
      typeof value.versionValidFrom === "string") &&
    "versionCount" in value &&
    typeof value.versionCount === "number" &&
    Number.isInteger(value.versionCount) &&
    value.versionCount >= 1
  );
};

type ProvisionTabKey = Pick<ProvisionViewPayload, "documentId" | "anchorId">;

/**
 * One tab per provision of a consolidation: opening the same provision again
 * focuses the tab that is already there.
 */
export const provisionTabId = ({
  anchorId,
  documentId,
}: ProvisionTabKey): string => `${PROVISION_VIEW}:${documentId}:${anchorId}`;

/** A short tab label: the provision, then the act it sits in. */
const provisionTabLabel = ({
  provisionLabel,
  statuteTitle,
}: Pick<ProvisionViewPayload, "provisionLabel" | "statuteTitle">): string =>
  statuteTitle === "" ? provisionLabel : `${provisionLabel} · ${statuteTitle}`;

export type ProvisionViewTab = {
  type: typeof PROVISION_VIEW;
  id: string;
  label: string;
  payload: ProvisionViewPayload;
};

/** The `openView` arguments for one provision; the id is the provision's. */
export const createProvisionViewTab = (
  payload: ProvisionViewPayload,
): ProvisionViewTab => ({
  type: PROVISION_VIEW,
  id: provisionTabId(payload),
  label: provisionTabLabel(payload),
  payload,
});
