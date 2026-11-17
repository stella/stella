/**
 * What a chat tab says it is about: the header's name and the composer
 * placeholder's context.
 */

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";

type BoundLegalDocumentLabelOptions = {
  /** The document the tab was opened about, when it was opened about one. */
  activeLegalKey: LegalDocumentChatKey | undefined;
  /** The document the main view shows, when it shows one. */
  mainDocument: ActiveLegalDocument | undefined;
};

/**
 * How the bound document is named, when it is the one on screen.
 *
 * The route is the only free source of the name: a chat tab carries the
 * document's key, not its case number, and resolving a key that is not on
 * screen would cost a full corpus read for a placeholder. A tab bound to a
 * document the reader has navigated away from keeps the thread's own title.
 */
export const boundLegalDocumentLabel = ({
  activeLegalKey,
  mainDocument,
}: BoundLegalDocumentLabelOptions): string | undefined => {
  if (activeLegalKey === undefined || mainDocument === undefined) {
    return undefined;
  }
  const { key, label } = activeLegalDocumentRef(mainDocument);
  return key === activeLegalKey ? label : undefined;
};

type ChatTabHeaderLabelOptions = {
  /** The active skill's title, translated when it is a built-in. */
  activeSkillName: string | undefined;
  boundDocumentLabel: string | undefined;
  /** What an untitled chat is called, translated. */
  newChatLabel: string;
  tabLabel: string;
};

/**
 * The tab's name: the thread's title once it has one. Until then the skill
 * the reader picked names it, ahead of the document they happen to stand on.
 */
export const chatTabHeaderLabel = ({
  activeSkillName,
  boundDocumentLabel,
  newChatLabel,
  tabLabel,
}: ChatTabHeaderLabelOptions): string =>
  isPlaceholderThreadTitle(tabLabel)
    ? (activeSkillName ?? boundDocumentLabel ?? newChatLabel)
    : tabLabel;

type ChatContextLabelOptions = {
  /** The active skill's title, translated when it is a built-in. */
  activeSkillName: string | undefined;
  boundDocumentLabel: string | undefined;
  /** The matters in the tab's context, named, in the order the tab holds them. */
  matterNames: readonly string[];
  tabLabel: string;
};

/**
 * What the composer says the chat is about. The active skill wins because the
 * reader chose it for this turn; the bound document comes next because it is
 * what the model will actually read. `undefined` when nothing names it: an
 * untitled chat is not about its own placeholder title, so the composer then
 * uses its context-free placeholder.
 */
export const chatContextLabel = ({
  activeSkillName,
  boundDocumentLabel,
  matterNames,
  tabLabel,
}: ChatContextLabelOptions): string | undefined => {
  if (activeSkillName !== undefined) {
    return activeSkillName;
  }
  if (boundDocumentLabel !== undefined) {
    return boundDocumentLabel;
  }
  const firstName = matterNames.at(0);
  if (firstName !== undefined) {
    return matterNames.length === 1
      ? firstName
      : `${firstName} +${String(matterNames.length - 1)}`;
  }
  const title = tabLabel.trim();
  return title.length > 0 && !isPlaceholderThreadTitle(title)
    ? title
    : undefined;
};
