import { Result } from "better-result";

import { stripDiacritics } from "@stll/text-normalize";

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
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isProvisionViewPayload = (
  value: unknown,
): value is ProvisionViewPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
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
export const provisionTabLabel = ({
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

type EnterSubmitKey = Pick<KeyboardEvent, "isComposing" | "key" | "shiftKey">;

/**
 * Whether an Enter press in the question box sends it. Enter while an IME is
 * composing confirms a candidate rather than ending the sentence, and
 * Shift+Enter opens a line, so neither of those sends.
 */
export const submitsOnEnter = ({
  isComposing,
  key,
  shiftKey,
}: EnterSubmitKey): boolean => key === "Enter" && !shiftKey && !isComposing;

type CitingDecisionRow = {
  caseNumber: string;
  court: string;
  sentenceText: string | null;
};

const foldForFilter = (value: string): string =>
  stripDiacritics(value).toLowerCase();

/**
 * Narrows the loaded pages to the rows whose case number, court, or cited
 * sentence contains the query. Diacritics are folded on both sides, so a
 * query typed without them still finds the decision.
 */
export const filterCitingDecisions = <T extends CitingDecisionRow>(
  decisions: readonly T[],
  query: string,
): T[] => {
  const needle = foldForFilter(query.trim());
  if (needle === "") {
    return [...decisions];
  }

  return decisions.filter((decision) =>
    foldForFilter(
      `${decision.caseNumber} ${decision.court} ${decision.sentenceText ?? ""}`,
    ).includes(needle),
  );
};

/**
 * Where a half-written question about a provision is kept while the reader is
 * sent to create an account.
 *
 * Creating the account navigates through `/auth/organization` and back, which
 * unmounts the inspector, so a draft held only in component state is lost at
 * exactly the moment the reader was told the round trip would return them to
 * what they were doing. The tab's own storage outlives that navigation and
 * dies with the tab, which is the right lifetime for an unsent question.
 */
const PROVISION_QUESTION_DRAFT_PREFIX = "stella.provision-question:";

/** One draft per provision of a consolidation, never shared between them. */
export const provisionQuestionDraftKey = ({
  anchorId,
  documentId,
}: Pick<ProvisionViewPayload, "anchorId" | "documentId">): string =>
  `${PROVISION_QUESTION_DRAFT_PREFIX}${documentId}:${anchorId}`;

/**
 * Reads, writes and clears through a `Storage` the caller hands in, because
 * the accessor itself throws where site data is blocked and is null through
 * the server and hydration passes.
 */
export const readProvisionQuestionDraft = (
  storage: Storage,
  key: string,
): string => Result.try(() => storage.getItem(key)).unwrapOr(null) ?? "";

export const writeProvisionQuestionDraft = (
  storage: Storage,
  key: string,
  question: string,
): void => {
  // An emptied box is the reader clearing the draft, not a value to keep.
  // A refused write (blocked site data, private window) loses only this
  // convenience, so the failure is consumed here rather than surfaced.
  Result.try(() => {
    if (question === "") {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, question);
  }).unwrapOr(undefined);
};

export const clearProvisionQuestionDraft = (
  storage: Storage,
  key: string,
): void => {
  // Same boundary as the write: a refused removal is not worth a signal.
  Result.try(() => {
    storage.removeItem(key);
  }).unwrapOr(undefined);
};
