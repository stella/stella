import { panic, Result } from "better-result";

import { filterBySearchQuery } from "@stll/text-normalize";

import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import { decisionCitationPresentationsById } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector-contract";

export {
  createProvisionViewTab,
  isProvisionViewPayload,
  PROVISION_VIEW,
  provisionTabId,
  provisionTabLabel,
} from "@/features/statutes/provision-inspector-contract";
export type { ProvisionViewPayload } from "@/features/statutes/provision-inspector-contract";

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

/**
 * Narrows the loaded pages to the rows whose case number, court, or cited
 * sentence contains the query. Case and accents are folded on both sides, so
 * a query typed without them still finds the decision.
 */
export const filterCitingDecisions = <T extends CitingDecisionRow>(
  decisions: readonly T[],
  query: string,
): T[] =>
  filterBySearchQuery({
    items: decisions,
    query,
    fields: ({ caseNumber, court, sentenceText }) => [
      `${caseNumber} ${court} ${sentenceText ?? ""}`,
    ],
  });

type PresentedCitingDecisionRow = CitingDecisionRow & {
  country: string;
  courtAbbreviation?: string | null | undefined;
  decisionId: string;
  ecli?: string | null | undefined;
};

/**
 * The rows the filter leaves, each with the chip size it is shown at. Chips
 * are sized against the rows on screen, not everything loaded: a shared court
 * code only needs the expanded chip while both decisions are visible.
 */
export const presentedCitingDecisions = <T extends PresentedCitingDecisionRow>(
  decisions: readonly T[],
  query: string,
): { decision: T; presentation: DecisionCitationPresentation }[] => {
  const visible = filterCitingDecisions(decisions, query);
  const presentations = decisionCitationPresentationsById(
    visible.map((decision) => ({
      decisionId: decision.decisionId,
      courtShortCode: decisionCitationCourtLabel(decision),
    })),
  );

  return visible.map((decision) => ({
    decision,
    presentation:
      presentations.get(decision.decisionId) ??
      panic("Citing decision missing collected identity"),
  }));
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
