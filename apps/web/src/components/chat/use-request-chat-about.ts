import { useCallback } from "react";

import { v7 as uuidv7 } from "uuid";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

/**
 * "Ask AI about this entity" — opens a fresh inspector chat tab
 * scoped to the current matter and pre-populates the composer with
 * the supplied mention chips. Used by row-action menus and the
 * matter-detail "ask" affordance.
 *
 * The legacy implementation drove the right-panel chat directly;
 * this version routes through the inspector store so chat lives
 * inside the same multifunctional pane as file viewers and other
 * tabs.
 */
export const useRequestChatAbout = (workspaceId?: string) => {
  const { focusThread, insertMentionIntoThread } = useChatEditorManager();
  const openChat = useInspectorStore((s) => s.openChat);

  return useCallback(
    (mentions: ChatMentionOption | ChatMentionOption[]) => {
      // Outside a workspace there's no inspector to open. The
      // legacy global chat is gone; if global "ask about" is ever
      // needed it can re-route through a workspace selector.
      if (!workspaceId) {
        return;
      }

      const threadId = uuidv7();
      // Auto-unminimises the pane and activates the new chat tab.
      openChat({
        id: threadId,
        contextMatterIds: [workspaceId],
      });

      const threadRef: ChatThreadRef = {
        scope: "workspace",
        threadId,
        workspaceId,
      };

      // Insert chips into the draft store so they're already in
      // the composer when ChatTabPanel mounts and the editor
      // attaches to this thread.
      const mentionList = Array.isArray(mentions) ? mentions : [mentions];
      for (const mention of mentionList) {
        insertMentionIntoThread(threadRef, mention);
      }

      focusThread(threadRef);
    },
    [focusThread, insertMentionIntoThread, openChat, workspaceId],
  );
};
