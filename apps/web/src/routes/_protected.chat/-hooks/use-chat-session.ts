import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ComponentProps } from "react";

import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { isToolUIPart } from "ai";

import type {
  ApprovalToolName,
  AskUserOutput,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { isApprovalToolName } from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";

type UseChatSessionOptions = {
  chat: Chat<PersistedChatMessage>;
  conversationId: string;
  workspaceId?: string | undefined;
};

export const useChatSession = ({
  chat,
  conversationId,
  workspaceId,
}: UseChatSessionOptions) => {
  const [conversationApprovedTools, setConversationApprovedTools] = useState(
    () => readConversationApprovedTools(conversationId),
  );
  const [alwaysApprovedTools, setAlwaysApprovedTools] = useState(() =>
    readStoredApprovedTools(CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY, "local"),
  );

  const {
    error,
    messages,
    regenerate,
    sendMessage: sendChatMessage,
    stop,
    status,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({ chat });

  const sendMessage = useCallback(
    async (message: Parameters<typeof sendChatMessage>[0]) => {
      await sendChatMessage(message);
    },
    [sendChatMessage],
  );

  const resendLatestMessage = useCallback(async () => {
    await regenerate();
  }, [regenerate]);

  const handleApprove = useCallback(
    (id: string, _toolName?: ApprovalToolName) =>
      addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse],
  );
  const handleAllowInConversation = useCallback(
    (id: string, toolName: ApprovalToolName) => {
      const next = new Set(conversationApprovedTools).add(toolName);
      setConversationApprovedTools(next);
      writeStoredApprovedTools(
        getConversationApprovedToolsStorageKey(conversationId),
        next,
        "session",
      );
      dispatchApprovedToolsChanged({
        conversationId,
        scope: "session",
      });
      addToolApprovalResponse({ id, approved: true });
    },
    [addToolApprovalResponse, conversationApprovedTools, conversationId],
  );
  const handleAlwaysAllow = useCallback(
    (id: string, toolName: ApprovalToolName) => {
      const next = new Set(alwaysApprovedTools).add(toolName);
      setAlwaysApprovedTools(next);
      writeStoredApprovedTools(
        CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY,
        next,
        "local",
      );
      dispatchApprovedToolsChanged({ scope: "local" });
      addToolApprovalResponse({ id, approved: true });
    },
    [addToolApprovalResponse, alwaysApprovedTools],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
  );
  const handleAskUserSubmit = useCallback(
    (toolCallId: string, output: AskUserOutput) =>
      addToolOutput({
        tool: "ask-user",
        toolCallId,
        output,
      }),
    [addToolOutput],
  );
  const streamdownComponents = useMemo(
    () => ({
      a: (props: ComponentProps<"a">) =>
        createElement(StreamdownMentionLink, {
          ...props,
          interactive: true,
          workspaceId,
        }),
    }),
    [workspaceId],
  );

  const approvalPendingMessageId = useMemo(
    () => getCurrentApprovalPendingMessageId(messages),
    [messages],
  );

  const isGenerating = status === "submitted" || status === "streaming";

  useEffect(() => {
    setConversationApprovedTools(readConversationApprovedTools(conversationId));
  }, [conversationId]);
  useEffect(() => {
    const handleApprovedToolsChanged = (event: Event) => {
      const detail = getApprovedToolsChangedDetail(event);
      if (!detail) {
        return;
      }

      if (detail.scope === "local") {
        setAlwaysApprovedTools(
          readStoredApprovedTools(
            CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY,
            "local",
          ),
        );
        return;
      }

      if (detail.conversationId !== conversationId) {
        return;
      }

      setConversationApprovedTools(
        readConversationApprovedTools(conversationId),
      );
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY) {
        return;
      }

      setAlwaysApprovedTools(
        readStoredApprovedTools(
          CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY,
          "local",
        ),
      );
    };

    window.addEventListener(
      CHAT_APPROVED_TOOLS_CHANGED_EVENT,
      handleApprovedToolsChanged,
    );
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(
        CHAT_APPROVED_TOOLS_CHANGED_EVENT,
        handleApprovedToolsChanged,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [conversationId]);

  return {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
    stop,
    isGenerating,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAlwaysAllow,
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  };
};

const CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY =
  "stella.chat.alwaysApprovedTools";
const CHAT_CONVERSATION_APPROVED_TOOLS_STORAGE_KEY_PREFIX =
  "stella.chat.conversationApprovedTools:";
const CHAT_APPROVED_TOOLS_CHANGED_EVENT = "stella:chat-approved-tools-changed";

type ApprovedToolsChangedDetail =
  | {
      scope: "local";
    }
  | {
      scope: "session";
      conversationId: string;
    };

const getConversationApprovedToolsStorageKey = (conversationId: string) =>
  `${CHAT_CONVERSATION_APPROVED_TOOLS_STORAGE_KEY_PREFIX}${conversationId}`;

const readConversationApprovedTools = (conversationId: string) =>
  readStoredApprovedTools(
    getConversationApprovedToolsStorageKey(conversationId),
  );

const getStorage = (scope: "local" | "session") => {
  if (typeof window === "undefined") {
    return null;
  }

  return scope === "local" ? window.localStorage : window.sessionStorage;
};

const readStoredApprovedTools = (
  key: string,
  scope: "local" | "session" = "session",
) => {
  const storage = getStorage(scope);
  if (!storage) {
    return new Set<ApprovalToolName>();
  }

  const raw = storage.getItem(key);
  if (!raw) {
    return new Set<ApprovalToolName>();
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<ApprovalToolName>();
    }

    return new Set(parsed.filter(isApprovalToolName));
  } catch {
    return new Set<ApprovalToolName>();
  }
};

const writeStoredApprovedTools = (
  key: string,
  tools: ReadonlySet<ApprovalToolName>,
  scope: "local" | "session",
) => {
  const storage = getStorage(scope);
  if (!storage) {
    return;
  }

  storage.setItem(key, JSON.stringify([...tools]));
};

const dispatchApprovedToolsChanged = (detail: ApprovedToolsChangedDetail) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(CHAT_APPROVED_TOOLS_CHANGED_EVENT, { detail }),
  );
};

const getApprovedToolsChangedDetail = (
  event: Event,
): ApprovedToolsChangedDetail | null => {
  if (!(event instanceof CustomEvent)) {
    return null;
  }

  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || !("scope" in detail)) {
    return null;
  }

  if (detail.scope === "local") {
    return { scope: "local" };
  }

  if (
    detail.scope === "session" &&
    "conversationId" in detail &&
    typeof detail.conversationId === "string"
  ) {
    return {
      scope: "session",
      conversationId: detail.conversationId,
    };
  }

  return null;
};

const getCurrentApprovalPendingMessageId = (
  messages: PersistedChatMessage[],
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages.at(index);
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    for (const part of msg.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") {
        return msg.id;
      }
    }

    return null;
  }

  return null;
};
