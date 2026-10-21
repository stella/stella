/**
 * Which matter a NEW chat is about.
 *
 * Only the route the user is on when they ask for the chat decides it: the
 * matter in the URL (`useRouteWorkspaceId`), or none for a global chat. An
 * open tab never does, and neither does the inspector's display matter,
 * which prefers the active tab's.
 * Chat tabs persist across navigation, so a tab's matter is where the user
 * was, and copying it scoped a "new" chat in matter A to matter B.
 *
 * Every new-chat entry point builds its scope here: the New chat shortcut,
 * Mod+J with no tabs open, the rail button and its menu, the command palette
 * and the dock's New chat. `new-chat-scope.test.ts` holds the census that
 * keeps a new `openChat` caller from copying a tab's scope.
 */

import type { ChatTab } from "@/components/inspector/inspector-store-types";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

type NewChatMatterScope = {
  contextMatterIds?: string[];
  workspaceId?: string;
};

export const newChatMatterScope = (
  routeWorkspaceId: string | undefined,
): NewChatMatterScope =>
  routeWorkspaceId === undefined
    ? {}
    : { workspaceId: routeWorkspaceId, contextMatterIds: [routeWorkspaceId] };

/**
 * The dock's New chat: a fresh thread beside the tab it is pressed in. The
 * tab's document and skill carry over, since they are what the tab is about;
 * its matter does not, since the route may have moved on.
 *
 * The id is named explicitly: a chat about a legal document otherwise
 * continues that document's one conversation, and this button asks for a
 * fresh one. Naming it also makes it the document's conversation, so the
 * reader's floating composer follows rather than staying on the thread left
 * here.
 */
export const dockNewChatArgs = ({
  id,
  routeWorkspaceId,
  tab,
}: {
  id: ChatThreadId;
  routeWorkspaceId: string | undefined;
  tab: Pick<ChatTab, "activeLegalKey" | "activeSkill">;
}) => ({
  id,
  ...(tab.activeLegalKey ? { activeLegalKey: tab.activeLegalKey } : {}),
  ...(tab.activeSkill ? { activeSkill: tab.activeSkill } : {}),
  ...newChatMatterScope(routeWorkspaceId),
});
