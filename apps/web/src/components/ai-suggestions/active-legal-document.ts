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
import {
  decisionChatKey,
  statuteChatKey,
} from "@/features/chat/legal-document-chat-key";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";

/**
 * Tagged, so that a site reading one corpus's fields cannot compile against
 * the other: `decisionId` resolves a decision's text, `documentId` a
 * consolidation's provisions, and the send endpoint has a separate field for
 * each.
 */
export type ActiveLegalDocument =
  | {
      type: "decision";
      /** How the reader names the decision, and what the composer labels it with. */
      caseNumber: string;
      /** What the send endpoint resolves the decision's text and marks by. */
      decisionId: string;
    }
  | {
      type: "statute";
      /** The consolidation the send endpoint selects provisions from. */
      documentId: string;
      /** The act's title, which the composer labels it with. */
      title: string;
    };

/**
 * The chat binding for the document a reader is reading.
 *
 * A decision travels as `activeDecision`, a consolidation as `activeStatute`;
 * both are resolved server-side from the id alone, so nothing of the document
 * is carried here beyond what names it on screen.
 */
export const activeLegalFromReaderTarget = (
  target: ReaderAnnotationTarget,
): ActiveLegalDocument => {
  switch (target.type) {
    case "decision": {
      return {
        type: "decision",
        caseNumber: target.caseNumber,
        decisionId: target.id,
      };
    }
    case "statute": {
      return { type: "statute", documentId: target.id, title: target.title };
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};

/** What the surfaces around the composer need of the bound document. */
export type ActiveLegalDocumentRef = {
  /** The document's one conversation, and the overlay's own identity. */
  key: LegalDocumentChatKey;
  /** How the composer's placeholder names the document. */
  label: string;
};

export const activeLegalDocumentRef = (
  activeLegal: ActiveLegalDocument,
): ActiveLegalDocumentRef => {
  switch (activeLegal.type) {
    case "decision": {
      return {
        key: decisionChatKey(activeLegal.decisionId),
        label: activeLegal.caseNumber,
      };
    }
    case "statute": {
      return {
        key: statuteChatKey(activeLegal.documentId),
        label: activeLegal.title,
      };
    }
    default: {
      activeLegal satisfies never;
      return panic(`Unhandled active legal document: ${String(activeLegal)}`);
    }
  }
};
