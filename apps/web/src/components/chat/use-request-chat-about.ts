import { useCallback } from "react";

import { v7 as uuidv7 } from "uuid";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";

export const useRequestChatAbout = (workspaceId?: string) => {
  const { focusThread, insertMentionIntoThread } = useChatEditorManager();
  const open = useChatPanelStore((state) => state.open);
  const globalThreadId = useChatPanelStore((state) => state.globalThreadId);
  const setGlobalThreadId = useChatPanelStore(
    (state) => state.setGlobalThreadId,
  );
  const setWorkspaceThreadId = useChatPanelStore(
    (state) => state.setWorkspaceThreadId,
  );
  const workspaceThreadId = useChatPanelStore((state) =>
    workspaceId ? (state.workspaceThreadIds[workspaceId] ?? null) : null,
  );

  return useCallback(
    (mentions: ChatMentionOption | ChatMentionOption[]) => {
      useTemplateAssistantStore.getState().close();
      open();

      const threadRef: ChatThreadRef = workspaceId
        ? {
            scope: "workspace",
            threadId: workspaceThreadId ?? uuidv7(),
            workspaceId,
          }
        : {
            scope: "global",
            threadId: globalThreadId ?? uuidv7(),
          };

      if (workspaceId) {
        setWorkspaceThreadId(workspaceId, threadRef.threadId);
      } else {
        setGlobalThreadId(threadRef.threadId);
      }

      const mentionList = Array.isArray(mentions) ? mentions : [mentions];
      for (const mention of mentionList) {
        insertMentionIntoThread(threadRef, mention);
      }

      focusThread(threadRef);
    },
    [
      focusThread,
      globalThreadId,
      insertMentionIntoThread,
      open,
      setGlobalThreadId,
      setWorkspaceThreadId,
      workspaceId,
      workspaceThreadId,
    ],
  );
};
