/**
 * Which chat capability carries a bound legal document to the send endpoint.
 *
 * One switch over the corpora, shared by the reader's floating composer and by
 * the inspector's chat tab, so a third corpus is a compile error here rather
 * than a getter one of the two surfaces silently never grew.
 */

import { panic } from "better-result";

import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import {
  LEGAL_DOCUMENT_CHAT_CORPUS,
  parseLegalDocumentChatKey,
} from "@/features/chat/legal-document-chat-key";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";

export type LegalDocumentChatContext = Pick<
  ChatThreadOptionsContext,
  "getActiveDecision" | "getActiveStatute"
>;

type LegalDocumentChatContextArgs = {
  /** The document the surface is bound to, as of this render. */
  documentKey: LegalDocumentChatKey;
  /**
   * The same key as of the latest render. A runtime outlives the render that
   * built it, so its getter reads the document the surface shows now — and
   * answers nothing at all once that is a document of another corpus, rather
   * than sending an id the field cannot resolve.
   */
  readDocumentKey: () => LegalDocumentChatKey | undefined;
};

export const legalDocumentChatContext = ({
  documentKey,
  readDocumentKey,
}: LegalDocumentChatContextArgs): LegalDocumentChatContext => {
  const document = parseLegalDocumentChatKey(documentKey);
  if (document === null) {
    return panic(`Malformed legal document chat key: ${documentKey}`);
  }
  switch (document.corpus) {
    case LEGAL_DOCUMENT_CHAT_CORPUS.decision: {
      return {
        getActiveDecision: () => {
          const latest = parseLegalDocumentChatKey(readDocumentKey());
          return latest?.corpus === LEGAL_DOCUMENT_CHAT_CORPUS.decision
            ? { decisionId: latest.id }
            : undefined;
        },
      };
    }
    case LEGAL_DOCUMENT_CHAT_CORPUS.statute: {
      return {
        getActiveStatute: () => {
          const latest = parseLegalDocumentChatKey(readDocumentKey());
          return latest?.corpus === LEGAL_DOCUMENT_CHAT_CORPUS.statute
            ? { documentId: latest.id }
            : undefined;
        },
      };
    }
    default: {
      document.corpus satisfies never;
      return panic(
        `Unhandled legal document corpus: ${String(document.corpus)}`,
      );
    }
  }
};
