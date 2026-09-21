/**
 * What the inspector rail's new-chat button opens.
 *
 * The rail sits beside whatever the main view shows. On a corpus document
 * that document owns the conversation, so the chat carries its key and joins
 * the one thread the reader's own composer writes to instead of opening a
 * rival beside it.
 *
 * No label travels with the document: the key resolves to a thread that may
 * already carry a title, and a label here would overwrite it on every press.
 * The tab's header names the document itself while the title is still the
 * placeholder.
 */

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import type { ChatTab } from "@/components/inspector/inspector-store-types";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";

type RailChatOpenArgsOptions = {
  activeSkill?: ChatTab["activeSkill"];
  /** The corpus document the main view shows, when it shows one. */
  legalDocument?: ActiveLegalDocument | undefined;
  /** The matter the rail is mounted in, when it is mounted in one. */
  workspaceId?: string | undefined;
};

type RailChatOpenArgs = {
  activeLegalKey?: LegalDocumentChatKey;
  activeSkill?: ChatTab["activeSkill"];
  contextMatterIds?: string[];
  label?: string;
  workspaceId?: string;
};

export const railChatOpenArgs = ({
  activeSkill,
  legalDocument,
  workspaceId,
}: RailChatOpenArgsOptions): RailChatOpenArgs => {
  const legalContext =
    legalDocument === undefined
      ? {}
      : { activeLegalKey: activeLegalDocumentRef(legalDocument).key };
  // A skill open from the rail keeps naming its skill: the reader picked the
  // skill, and the document is only where they happen to be standing.
  const skillContext =
    activeSkill === undefined
      ? {}
      : { activeSkill, label: activeSkill.skillName };
  const matterContext =
    workspaceId === undefined
      ? {}
      : { workspaceId, contextMatterIds: [workspaceId] };

  return { ...legalContext, ...skillContext, ...matterContext };
};
