/**
 * The legal document the main view is showing, as the chat surfaces need it.
 *
 * The route is the source: a decision page and a statute page each carry
 * their document in loader data, so nothing has to mirror it into a store
 * that could then disagree with the address bar.
 */

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";

type MainLegalDocumentOptions = {
  decision: { caseNumber: string; id: string } | undefined;
  statute: { id: string; title: string } | undefined;
};

/**
 * One route matches at a time, so at most one of the two is present; the
 * decision is read first to keep the order fixed rather than incidental.
 */
export const mainLegalDocument = ({
  decision,
  statute,
}: MainLegalDocumentOptions): ActiveLegalDocument | undefined => {
  if (decision !== undefined) {
    return {
      type: "decision",
      caseNumber: decision.caseNumber,
      decisionId: decision.id,
    };
  }
  if (statute !== undefined) {
    return { type: "statute", documentId: statute.id, title: statute.title };
  }
  return undefined;
};
