/**
 * The legal document a floating chat composer is bound to.
 *
 * The file overlay names what a question is about — a PDF, a DOCX, an external
 * page — so the model answers about the document in front of the reader rather
 * than guessing from the words alone. A legal reader shows a document from the
 * corpus, and this is the branch that carries one.
 */

import { panic } from "better-result";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";

/**
 * Tagged although the corpus the chat can carry is currently one: the tag is
 * what makes a second corpus a compile error at every site that reads a
 * decision's fields, rather than a branch someone has to remember to add.
 */
export type ActiveLegalDocument = {
  type: "decision";
  /** How the reader names the decision, and what the composer labels it with. */
  caseNumber: string;
  /** What the send endpoint resolves the decision's text and marks by. */
  decisionId: string;
};

/**
 * The chat binding for the document a reader is reading, or null when the chat
 * has no way to carry it.
 *
 * A decision travels as `activeDecision`, which the send endpoint resolves to
 * the decision's text and the reader's own marks on it. A statute
 * consolidation has no counterpart: the send request carries no legislation
 * context and no chat tool reads one outside Spain's BOE, so binding a
 * composer to a statute would drop the document without saying so. The statute
 * readers keep the ask affordances that name the provision in the prompt until
 * the API accepts one.
 */
export const activeLegalFromReaderTarget = (
  target: ReaderAnnotationTarget,
): ActiveLegalDocument | null => {
  switch (target.type) {
    case "decision": {
      return {
        type: "decision",
        caseNumber: target.caseNumber,
        decisionId: target.id,
      };
    }
    case "statute": {
      return null;
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};
