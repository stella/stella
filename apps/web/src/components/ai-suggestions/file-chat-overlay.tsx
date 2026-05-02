/**
 * FileChatOverlay
 *
 * The floating chat that sits on top of a file viewer (DOCX, PDF).
 * Same backend, same composer, same persistence as the inspector
 * Chat tab — just a different shell:
 *   - bar is absolutely positioned at the bottom of the viewer
 *   - thread is a collapsible glass card that opens above the bar
 *
 * Suggestion-accept UI from the previous file-overlay flow is not
 * here yet; it will come back as a tool-call surface (the model
 * proposes edits via a `propose-suggestion` tool, the frontend
 * extracts and renders accept/reject cards). That work is Phase E.
 */

import { Suspense, useEffect, useEffectEvent, useMemo, useState } from "react";

import { cn } from "@stll/ui/lib/utils";
import { useSuspenseQuery } from "@tanstack/react-query";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { PromptBar } from "@/components/ai-suggestions/host";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

type ActiveFile = {
  entityId: string;
  editable?: boolean | undefined;
  fileName: string;
};

type FileChatOverlayProps = {
  /** Workspace this file belongs to. Scopes the thread + mention sources. */
  workspaceId: string;
  /**
   * Stable identifier for this file's chat thread. Use the file's
   * entity id (or any per-file unique string) so drafts + history
   * persist across mounts and stay isolated from other files'
   * chats.
   */
  chatThreadId: string;
  /**
   * Surfaced to the model via the chat transport so prompts can
   * reference "the file you're looking at" and tools can resolve
   * its entity. Optional — when omitted the model still works
   * fine but loses the file-context hint.
   */
  activeFile?: ActiveFile | undefined;
};

export const FileChatOverlay = ({
  workspaceId,
  chatThreadId,
  activeFile,
}: FileChatOverlayProps) => (
  // Suspense boundary keeps the chat-thread fetch local to the
  // overlay — without it, a cold cache propagates the suspension
  // up to the file route and shows the route's pending screen.
  <Suspense
    fallback={
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center"
      >
        <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
      </div>
    }
  >
    <FileChatOverlayInner
      activeFile={activeFile}
      chatThreadId={chatThreadId}
      workspaceId={workspaceId}
    />
  </Suspense>
);

const FileChatOverlayInner = ({
  workspaceId,
  chatThreadId,
  activeFile,
}: FileChatOverlayProps) => {
  const t = useTranslations();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const getActiveFile = useEffectEvent(() => activeFile);
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const threadRef = useMemo<ChatThreadRef>(
    () => ({
      scope: "workspace",
      threadId: chatThreadId,
      workspaceId,
    }),
    [chatThreadId, workspaceId],
  );

  const { data } = useSuspenseQuery(
    chatThreadOptions({
      key: threadRef,
      context: {
        allowMissingThread: true,
        getUserContext,
        getActiveFile: () => getActiveFile(),
      },
    }),
  );
  const { chat } = data;

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
  } = useChatSession({ chat, threadRef, workspaceId });

  const filePlaceholder =
    activeFile === undefined
      ? undefined
      : t(
          activeFile.editable
            ? "chat.editableFilePlaceholder"
            : "chat.filePlaceholder",
          { fileName: activeFile.fileName },
        );
  const filePlaceholderAction =
    activeFile === undefined
      ? undefined
      : t(
          activeFile.editable
            ? "chat.editableFilePlaceholderAction"
            : "chat.filePlaceholderAction",
        );

  const editorController = useChatEditor({
    placeholder: filePlaceholder,
    threadRef,
  });

  const [panelOpen, setPanelOpen] = useState(false);
  const hasMessages = messages.length > 0;
  // Auto-open the thread panel as soon as the first message
  // lands so users see streaming without having to click the
  // chevron themselves.
  useEffect(() => {
    if (hasMessages) {
      setPanelOpen(true);
    }
  }, [hasMessages]);

  return (
    <>
      {panelOpen && hasMessages && (
        <div
          aria-label="AI thread"
          className={cn(
            // Sizing rules: grows with content but caps at ~45dvh
            // / 380px so the panel doesn't dominate the file
            // viewer. No min-height — short threads stay short.
            "absolute start-1/2 bottom-[88px] z-40 flex max-h-[min(45dvh,380px)] min-h-0 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border",
            "bg-popover/35 border-border/50 text-popover-foreground",
            "[backdrop-filter:blur(28px)_saturate(180%)] [-webkit-backdrop-filter:blur(28px)_saturate(180%)]",
            "before:bg-foreground/[0.06] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
            "hover:bg-popover/92 focus-within:bg-popover/92 hover:border-border focus-within:border-border",
            "transition-[background-color,border-color] duration-200 ease-out",
            "shadow-[0_1px_2px_rgb(0_0_0/0.04),0_16px_48px_rgb(0_0_0/0.10)]",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
          )}
          role="dialog"
        >
          {/* Plain scroll container — bypasses the legacy
              Conversation's `size-full` chain, which only resolves
              correctly when the parent has an explicit height
              (this overlay uses `max-h` only, so flex-1 children
              don't get a definite size to base `size-full` on). */}
          <div
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
            style={{ scrollbarGutter: "stable" }}
          >
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
          </div>
        </div>
      )}

      <PromptBar
        editorController={editorController}
        emptyPlaceholder={
          activeFile && filePlaceholderAction ? (
            <span className="text-muted-foreground/70 flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
              <span className="shrink-0">{filePlaceholderAction}</span>
              <span className="text-foreground/75 max-w-64 truncate">
                {activeFile.fileName}
              </span>
            </span>
          ) : undefined
        }
        layout="floating"
        onStop={() => {
          void stop();
        }}
        onSubmit={({ prompt }) => {
          // Always pop the thread open on send, even if the user
          // minimised it earlier — they're sending a new prompt
          // and want to see the response stream in.
          setPanelOpen(true);
          void sendMessage({ text: prompt });
        }}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        panelOpen={panelOpen}
        pendingCount={0}
        showThreadToggle={hasMessages}
        status={isGenerating ? "generating" : "idle"}
      />
    </>
  );
};
