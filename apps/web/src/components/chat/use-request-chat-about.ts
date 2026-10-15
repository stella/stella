import { useReducer, useRef } from "react";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { PastedTextAttrs } from "@/components/chat-pasted-text-extension";
import {
  nextSidePanelChatStatus,
  SIDE_PANEL_CHAT_READY_MS,
  SIDE_PANEL_CHAT_STATUS,
} from "@/components/chat/side-panel-chat-status.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useMountEffect } from "@/hooks/use-effect";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";

export type InspectorChatRequest = {
  /** The matters the chat is scoped to. */
  contextMatterIds: readonly string[];
  /** Chips to start the composer with. */
  mentions?: readonly ChatMentionOption[] | undefined;
  /** A quotation to start the composer with, after any mentions. */
  quote?: PastedTextAttrs | undefined;
  /** An existing thread (a fork) to open; absent opens a fresh one. */
  threadId?: ChatThreadId | undefined;
  /** The matter the chat belongs to; absent, it is a global chat. */
  workspaceId?: string | undefined;
};

/**
 * Opens a chat as a tab in the inspector, the one path every "open in the
 * side panel" action takes: "ask about this" from row menus, a selection
 * asked about in a new chat, a fork opened beside its source. The inspector
 * is mounted on every signed-in route, global `/chat` included, and hosts a
 * chat without a matter as a global thread.
 *
 * The composer is pre-filled through the draft store, so the chips are
 * already in place when the tab's editor attaches to the thread; nothing is
 * sent. An empty chat tab focuses its composer on mount, which puts the caret
 * after the pre-filled content. The chat's rail tab flashes, so the eye finds
 * where it opened even when the pane was already showing.
 */
const useOpenChatInInspector = () => {
  const { focusThread, insertMentionIntoThread, insertPastedTextIntoThread } =
    useChatEditorManager();
  const openChat = useInspectorTabsStore((s) => s.openChat);
  const flashTab = useInspectorTabsStore((s) => s.flashTab);

  return ({
    contextMatterIds,
    mentions = [],
    quote,
    threadId = createChatThreadId(),
    workspaceId,
  }: InspectorChatRequest): ChatThreadRef => {
    // Auto-unminimises the pane and activates the chat tab.
    openChat({
      id: threadId,
      workspaceId,
      contextMatterIds: [...contextMatterIds],
    });
    flashTab(threadId);

    const threadRef: ChatThreadRef =
      workspaceId === undefined
        ? { scope: "global", threadId }
        : { scope: "workspace", threadId, workspaceId };

    for (const mention of mentions) {
      insertMentionIntoThread(threadRef, mention);
    }
    if (quote !== undefined) {
      insertPastedTextIntoThread(threadRef, quote);
    }

    focusThread(threadRef);
    return threadRef;
  };
};

/**
 * A control that opens a chat in the side panel and says so where the user
 * is looking: "creating" while a fork waits on the server, then "available
 * in the side panel" for a moment, while the chat's rail tab flashes. The
 * fork menu and the selection bar share it, so both read the same.
 *
 * `begin` marks the wait (skipped when the chat opens at once), `open` opens
 * the chat and confirms, `fail` drops the wait; the caller reports the error
 * as before.
 */
export const useSidePanelChat = () => {
  const openChatInInspector = useOpenChatInInspector();
  const [status, dispatch] = useReducer(
    nextSidePanelChatStatus,
    SIDE_PANEL_CHAT_STATUS.idle,
  );
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSettle = () => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  };

  useMountEffect(() => cancelSettle);

  return {
    begin: () => {
      cancelSettle();
      dispatch("start");
    },
    fail: () => {
      dispatch("failed");
    },
    open: (request: InspectorChatRequest): ChatThreadRef => {
      const threadRef = openChatInInspector(request);
      cancelSettle();
      dispatch("opened");
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        dispatch("settled");
      }, SIDE_PANEL_CHAT_READY_MS);
      return threadRef;
    },
    status,
  };
};

/**
 * "Ask AI about this entity": a fresh inspector chat scoped to the matter,
 * its composer holding the supplied mention chips. Used by row-action menus
 * and the matter-detail "ask" affordance. Without a matter it opens a
 * global chat.
 */
export const useRequestChatAbout = (workspaceId?: string) => {
  const openChatInInspector = useOpenChatInInspector();

  return (mentions: ChatMentionOption | ChatMentionOption[]) => {
    openChatInInspector({
      contextMatterIds: workspaceId === undefined ? [] : [workspaceId],
      mentions: Array.isArray(mentions) ? mentions : [mentions],
      workspaceId,
    });
  };
};
