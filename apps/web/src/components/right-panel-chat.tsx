import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Chat } from "@ai-sdk/react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import {
  MessageSquareIcon,
  PlusIcon,
  SquareIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import type { ChatInputDraft } from "@/components/chat-editor-provider";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { useRequestChatAbout } from "@/components/chat/use-request-chat-about";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { useDevStore } from "@/lib/dev-store";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { useWorkspaceChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-workspace-chat-mention-registration";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  invalidateGroupedChatThreads,
} from "@/routes/_protected.chat/-queries";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type ActiveFileContext = {
  entityId: string;
  fileName: string;
};

type ChatThreadContext = {
  allowMissingThread?: boolean | undefined;
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  getUserContext: () => {
    locale: string;
    timezone: string;
    userName: string;
  };
};

type RightPanelChatProps = {
  open: boolean;
  workspaceId?: string | undefined;
};

export const RightPanelChat = ({ open, workspaceId }: RightPanelChatProps) => {
  if (workspaceId) {
    return <WorkspaceRightPanelChat open={open} workspaceId={workspaceId} />;
  }

  return <GlobalRightPanelChat open={open} />;
};

const GlobalRightPanelChat = ({ open }: { open: boolean }) => {
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const globalThreadId = useChatPanelStore((state) => state.globalThreadId);
  const setGlobalThreadId = useChatPanelStore(
    (state) => state.setGlobalThreadId,
  );

  const setCurrentThreadId = useCallback(
    (threadId: string | null) => {
      setGlobalThreadId(threadId);
    },
    [setGlobalThreadId],
  );

  const threadRef = getPanelThreadRef({
    threadId: globalThreadId,
  });

  const threadContext = useMemo<ChatThreadContext>(
    () => ({
      allowMissingThread: true,
      getUserContext,
    }),
    [],
  );

  const handleStartNewThread = useCallback(
    async ({
      draft,
      threadId,
    }: {
      draft: ChatInputDraft;
      threadId: string;
    }) => {
      const nextThreadRef = getPanelThreadRef({
        threadId,
      });

      if (!nextThreadRef) {
        return;
      }

      const chat = await queryClient.ensureQueryData(
        chatThreadOptions({
          key: nextThreadRef,
          context: threadContext,
        }),
      );

      setCurrentThreadId(threadId);
      await chat.sendMessage(await buildChatRequestMessage(draft));
      await invalidateGroupedChatThreads(queryClient);
    },
    [queryClient, setCurrentThreadId, threadContext],
  );

  if (!threadRef) {
    return (
      <EmptyThreadPanel
        onDraftStart={setCurrentThreadId}
        onSubmit={handleStartNewThread}
        open={open}
      />
    );
  }

  return (
    <ActiveThreadPanel
      open={open}
      onNewChat={() => setCurrentThreadId(null)}
      threadContext={threadContext}
      threadRef={threadRef}
    />
  );
};

const WorkspaceRightPanelChat = ({
  open,
  workspaceId,
}: {
  open: boolean;
  workspaceId: string;
}) => {
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const getActiveFile = useEffectEvent(() => getSidebarActiveFile(workspaceId));
  const workspaceViewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const workspacePdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    shouldThrow: false,
  });
  const activeViewId =
    workspacePdfMatch?.params.viewId ?? workspaceViewMatch?.params.viewId;
  const workspaceThreadId = useChatPanelStore(
    (state) => state.workspaceThreadIds[workspaceId] ?? null,
  );
  const setWorkspaceThreadId = useChatPanelStore(
    (state) => state.setWorkspaceThreadId,
  );

  useWorkspaceChatMentionRegistration(workspaceId, activeViewId);

  const setCurrentThreadId = useCallback(
    (threadId: string | null) => {
      setWorkspaceThreadId(workspaceId, threadId);
    },
    [setWorkspaceThreadId, workspaceId],
  );

  const threadRef = getPanelThreadRef({
    threadId: workspaceThreadId,
    workspaceId,
  });

  const threadContext = useMemo<ChatThreadContext>(
    () => ({
      allowMissingThread: true,
      getActiveFile,
      getUserContext,
    }),
    [],
  );

  const handleStartNewThread = useCallback(
    async ({
      draft,
      threadId,
    }: {
      draft: ChatInputDraft;
      threadId: string;
    }) => {
      const nextThreadRef = getPanelThreadRef({
        threadId,
        workspaceId,
      });

      if (!nextThreadRef) {
        return;
      }

      const chat = await queryClient.ensureQueryData(
        chatThreadOptions({
          key: nextThreadRef,
          context: threadContext,
        }),
      );

      setCurrentThreadId(threadId);
      await chat.sendMessage(await buildChatRequestMessage(draft));
      await invalidateGroupedChatThreads(queryClient);
    },
    [queryClient, setCurrentThreadId, threadContext, workspaceId],
  );

  if (!threadRef) {
    return (
      <EmptyThreadPanel
        onDraftStart={setCurrentThreadId}
        onSubmit={handleStartNewThread}
        open={open}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <ActiveThreadPanel
      open={open}
      onNewChat={() => setCurrentThreadId(null)}
      threadContext={threadContext}
      threadRef={threadRef}
      workspaceId={workspaceId}
    />
  );
};

const EmptyThreadPanel = ({
  onDraftStart,
  onSubmit,
  open,
  workspaceId,
}: {
  onDraftStart: (threadId: string) => void;
  onSubmit: (input: {
    draft: ChatInputDraft;
    threadId: string;
  }) => Promise<void>;
  open: boolean;
  workspaceId?: string | undefined;
}) => {
  const t = useTranslations();
  // eslint-disable-next-line typescript/no-unnecessary-type-arguments
  const draftThreadRef = useRef<ChatThreadRef>(
    workspaceId
      ? {
          scope: "workspace",
          threadId: uuidv7(),
          workspaceId,
        }
      : {
          scope: "global",
          threadId: uuidv7(),
        },
  );
  const controller = useChatEditor({
    onDraftStart: () => onDraftStart(draftThreadRef.current.threadId),
    threadRef: draftThreadRef.current,
  });
  const { handleDragOver, handleDrop, handlePaste } = controller;
  const entityDrop = useEntityDropTarget(workspaceId);

  return (
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      ref={entityDrop.containerRef}
    >
      {entityDrop.isDragOver && <DropOverlay />}
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-4 px-3",
          entityDrop.isDragOver && "invisible",
        )}
      >
        <MessageSquareIcon className="text-muted-foreground/30 size-8" />
        <p className="text-foreground text-sm font-medium">
          {t("chat.greeting")}
        </p>
      </div>
      <div className="p-3">
        <ChatInputSurface
          autoFocus={open}
          controller={controller}
          onSubmit={async (draft) => {
            await onSubmit({
              draft,
              threadId: draftThreadRef.current.threadId,
            });
          }}
        />
      </div>
    </div>
  );
};

const ActiveThreadPanel = ({
  open,
  onNewChat,
  threadContext,
  threadRef,
  workspaceId,
}: {
  open: boolean;
  onNewChat: () => void;
  threadContext: ChatThreadContext;
  threadRef: ChatThreadRef;
  workspaceId?: string | undefined;
}) => {
  const { data: chat, isLoading } = useQuery(
    chatThreadOptions({
      key: threadRef,
      context: threadContext,
    }),
  );

  if (isLoading || !chat) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="border-foreground/20 border-t-foreground size-4 animate-spin rounded-full border-2" />
      </div>
    );
  }

  return (
    <ActiveThreadPanelInner
      chat={chat}
      open={open}
      onNewChat={onNewChat}
      threadRef={threadRef}
      workspaceId={workspaceId}
    />
  );
};

const ActiveThreadPanelInner = ({
  chat,
  open,
  onNewChat,
  threadRef,
  workspaceId,
}: {
  chat: Chat<PersistedChatMessage>;
  open: boolean;
  onNewChat: () => void;
  threadRef: ChatThreadRef;
  workspaceId?: string | undefined;
}) => {
  const t = useTranslations();
  const showToolCalls = useDevStore((state) => state.showToolCalls);
  const controller = useChatEditor({ threadRef });
  const { handleDragOver, handleDrop, handlePaste } = controller;
  const entityDrop = useEntityDropTarget(workspaceId);
  const {
    messages,
    sendMessage,
    stop,
    isGenerating,
    autoApprovedTools,
    handleApprove,
    handleDeny,
    handleAlwaysAllow,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat });

  return (
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      ref={entityDrop.containerRef}
    >
      {entityDrop.isDragOver && <DropOverlay />}
      <div
        className={cn(
          "flex items-center gap-1 border-b px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button
          onClick={onNewChat}
          size="icon-sm"
          title={t("chat.newChat")}
          variant="ghost"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>

      <Conversation>
        <ConversationContent className="gap-4 p-3">
          <ChatThreadMessages
            approvalPendingMessageId={approvalPendingMessageId}
            autoApprovedTools={autoApprovedTools}
            handleAlwaysAllow={handleAlwaysAllow}
            handleApprove={handleApprove}
            handleDeny={handleDeny}
            isGenerating={isGenerating}
            messages={messages}
            onAskUserSubmit={async (text) => {
              await sendMessage({ text });
            }}
            showThinkingIndicator
            showToolCalls={showToolCalls}
            streamdownComponents={streamdownComponents}
            workspaceId={workspaceId}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex items-end gap-2 p-3">
        <ChatInputSurface
          autoFocus={open}
          className="flex-1"
          controller={controller}
          disabled={isGenerating}
          onSubmit={async (draft) => {
            await sendMessage(await buildChatRequestMessage(draft));
          }}
        />
        {isGenerating && (
          <Button
            aria-label={t("common.cancel")}
            onClick={async () => await stop()}
            size="icon-sm"
            variant="outline"
          >
            <SquareIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
};

const DropOverlay = () => {
  const t = useTranslations();

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-50",
        "flex items-center justify-center rounded-lg",
        "border-foreground/20 border-2 border-dashed",
        "bg-foreground/5",
      )}
    >
      <div className="text-foreground/50 flex flex-col items-center gap-2">
        <UploadIcon className="size-6" />
        <span className="text-xs font-medium">{t("chat.chatAbout")}</span>
      </div>
    </div>
  );
};

const useEntityDropTarget = (workspaceId: string | undefined) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const requestChatAbout = useRequestChatAbout(workspaceId);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !workspaceId) {
      return undefined;
    }

    return dropTargetForElements({
      element,
      canDrop: ({ source }) => source.data.type === ENTITY_DRAG_TYPE,
      onDragEnter: () => setIsDragOver(true),
      onDragLeave: () => setIsDragOver(false),
      onDrop: ({ source }) => {
        setIsDragOver(false);

        const entities = source.data.entities;
        if (!Array.isArray(entities)) {
          return;
        }

        const mentions: ChatMentionOption[] = [];
        for (const entity of entities) {
          if (
            entity === null ||
            typeof entity !== "object" ||
            !("entityId" in entity) ||
            !("name" in entity) ||
            !("kind" in entity)
          ) {
            continue;
          }

          const mention = toEntityMention(entity);
          if (mention) {
            mentions.push(mention);
          }
        }

        if (mentions.length > 0) {
          requestChatAbout(mentions);
        }
      },
    });
  }, [requestChatAbout, workspaceId]);

  return { containerRef, isDragOver };
};

const getPanelThreadRef = ({
  threadId,
  workspaceId,
}: {
  threadId: string | null;
  workspaceId?: string | undefined;
}): ChatThreadRef | null => {
  if (!threadId) {
    return null;
  }

  return workspaceId
    ? {
        scope: "workspace",
        threadId,
        workspaceId,
      }
    : {
        scope: "global",
        threadId,
      };
};

const getSidebarActiveFile = (
  workspaceId: string | undefined,
): ActiveFileContext | undefined => {
  if (!workspaceId) {
    return undefined;
  }

  const { activeId, tabs } = useInspectorStore.getState();
  const activeTab = tabs.find((tab) => tab.id === activeId);
  if (!activeTab || activeTab.type !== "pdf") {
    return undefined;
  }

  if (activeTab.workspaceId !== workspaceId) {
    return undefined;
  }

  return {
    entityId: activeTab.entityId,
    fileName: activeTab.label,
  };
};

const toEntityMention = (entity: unknown): ChatMentionOption | null => {
  if (entity === null || typeof entity !== "object") {
    return null;
  }

  const entityId =
    "entityId" in entity && typeof entity.entityId === "string"
      ? entity.entityId
      : null;
  const label =
    "name" in entity && typeof entity.name === "string" ? entity.name : null;
  const kind =
    "kind" in entity && typeof entity.kind === "string" ? entity.kind : null;

  if (!entityId || !label || !kind) {
    return null;
  }

  const mimeType =
    "mimeType" in entity && typeof entity.mimeType === "string"
      ? entity.mimeType
      : null;

  return {
    id: entityId,
    label,
    category: "entity",
    kind,
    mimeType,
  };
};
