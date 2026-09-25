import { useTranslations } from "use-intl";

import {
  LEGAL_DOCUMENT_CHAT_CORPUS,
  parseLegalDocumentChatKey,
} from "@/features/chat/legal-document-chat-key";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import type { TranslationKey } from "@/i18n/types";
import type { PromptSuggestion } from "@/lib/prompts/types";

/**
 * The questions a chat about a decision opens with.
 *
 * Fixed and few: a reader beside a judgment wants its holding, the law it
 * applied, the authorities it leaned on and the dispute it came from, and the
 * saved-prompt cards (drafting, comparing, redlining a document) answer none
 * of that.
 */
const DECISION_CHAT_PROMPTS = [
  {
    id: "holding",
    bodyKey: "caseLaw.chat.prompts.holding.body",
    nameKey: "caseLaw.chat.prompts.holding.name",
  },
  {
    id: "provisions",
    bodyKey: "caseLaw.chat.prompts.provisions.body",
    nameKey: "caseLaw.chat.prompts.provisions.name",
  },
  {
    id: "precedent",
    bodyKey: "caseLaw.chat.prompts.precedent.body",
    nameKey: "caseLaw.chat.prompts.precedent.name",
  },
  {
    id: "facts",
    bodyKey: "caseLaw.chat.prompts.facts.body",
    nameKey: "caseLaw.chat.prompts.facts.name",
  },
] as const satisfies readonly {
  id: string;
  bodyKey: TranslationKey;
  nameKey: TranslationKey;
}[];

/**
 * The decision prompts when the chat tab is about a decision, `undefined`
 * otherwise; the caller then falls back to the reader's suggested skills.
 */
export const useDecisionChatPrompts = (
  activeLegalKey: LegalDocumentChatKey | undefined,
): PromptSuggestion[] | undefined => {
  const t = useTranslations();
  const parsed = parseLegalDocumentChatKey(activeLegalKey);

  if (parsed?.corpus !== LEGAL_DOCUMENT_CHAT_CORPUS.decision) {
    return undefined;
  }

  return DECISION_CHAT_PROMPTS.map(({ id, bodyKey, nameKey }) => ({
    id,
    name: t(nameKey),
    body: t(bodyKey),
  }));
};
