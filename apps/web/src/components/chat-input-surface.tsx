import "./chat-editor.css";
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";

import { CpuIcon, PaperclipIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useChatComposerWiring } from "@/components/chat-editor-provider";
import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ChatContextMeter } from "@/components/chat/chat-context-meter";
import type { ChatContextUsage } from "@/components/chat/chat-context-meter";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import { PromptEditorContent } from "@/components/prompt-editor";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";

type ChatInputSurfaceProps = {
  autoFocus?: boolean;
  className?: string;
  controller: ChatEditorController;
  disabled?: boolean;
  onSubmit: (draft: ChatInputDraft) => Promise<void> | void;
  onFocusChange?: ((focused: boolean) => void) | undefined;
  /**
   * When set, the surface renders an in-line stop button while
   * generating instead of the send affordance, replacing the need
   * for a separate Stop button next to the input.
   */
  isGenerating?: boolean;
  onStop?: () => void;
  /**
   * Whether this surface will send the next request anonymized.
   * Drives the blue-ring "shield active" treatment so the cue
   * matches what gets sent. The shared input is mounted from
   * surfaces with different toggle scopes (per-thread store on
   * `/chat`, local state in the inspector tab, none in the file
   * overlay), so reading from a global store here would render a
   * shield on raw requests or hide it on protected ones.
   */
  anonymized?: boolean;
  /**
   * Model-context estimate for this thread's next send. Renders a small ring
   * meter on the far end of the status row below the box. Undefined on the
   * new-chat surface (no thread yet), where nothing is rendered.
   */
  contextUsage?: ChatContextUsage | undefined;
  /**
   * Left cluster of the slim status row rendered below the bordered box
   * (matter picker, anonymization toggle, ...). Rendered as-is; callers own
   * layout inside the `text-xs` row.
   */
  statusBarStart?: ReactNode;
  /**
   * When provided, the (+) menu gains a "Models" item. Omit on surfaces
   * without a model selector.
   */
  onOpenModelSelector?: (() => void) | undefined;
  /**
   * When provided, the (+) menu gains an "MCP servers" item. Omit on
   * surfaces that don't navigate to the tools catalogue.
   */
  onOpenMcpServers?: (() => void) | undefined;
};

export const ChatInputSurface = ({
  autoFocus,
  className,
  controller,
  disabled = false,
  onSubmit,
  onFocusChange,
  isGenerating = false,
  onStop,
  anonymized = false,
  contextUsage,
  statusBarStart,
  onOpenModelSelector,
  onOpenMcpServers,
}: ChatInputSurfaceProps) => {
  const t = useTranslations();
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    attachments,
    canSubmit,
    editor,
    fileInputAccept,
    fileInputRef,
    focus,
    handleDragOver,
    handleDrop,
    handleFileInputChange,
    handlePaste,
    isEmpty,
    openFilePicker,
    placeholder,
    removeFile,
  } = controller;
  const inputDisabled = disabled;
  // Submitting stays enabled while the assistant streams: a send
  // during a turn is queued by `useChatSession` and dispatched once
  // the response finishes, so overlapping requests can't happen.
  const submitDisabled = disabled;

  // A failed send has already restored the draft (see `submit` in
  // chat-editor-provider), so the only thing missing is a user-visible
  // signal. Route it through analytics AND a toast: swallowing the
  // failure into telemetry alone leaves the send silently lost.
  const handleSubmitError = useCallback(
    (error: unknown): void => {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
    [t],
  );

  const { submitDraft } = useChatComposerWiring({
    controller,
    inputDisabled,
    onSubmit,
    onSubmitError: handleSubmitError,
    submitDisabled,
  });

  useExternalSyncEffect(() => {
    if (!autoFocus) {
      return;
    }

    focus();
  }, [autoFocus, focus]);

  const handleFocus = () => {
    onFocusChange?.(true);
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) {
      return;
    }

    onFocusChange?.(false);
  };

  const showStatusRow =
    statusBarStart !== undefined || contextUsage !== undefined;

  return (
    // Outer wrapper carries caller positioning (`className`) and the slim
    // status row; the inner box keeps the border and the drag/paste/focus
    // handlers so the row sits outside the border but still inside scope.
    <div className={cn("flex flex-col", className)}>
      <div
        className={cn(
          "bg-background rounded-lg border",
          "transition-colors",
          // Default focus border (gray) only when not in anonymized
          // mode — otherwise the gray border landed on top of the
          // blue ring and read as a double-ring on click.
          !inputDisabled && !anonymized && "focus-within:border-ring",
          anonymized &&
            "ring-info/40 border-info/40 focus-within:border-info/60 shadow-[0_0_0_4px_rgb(from_var(--color-info)_r_g_b_/_0.08)] ring-1",
        )}
        onBlurCapture={handleBlur}
        onDragOver={inputDisabled ? undefined : handleDragOver}
        onDrop={inputDisabled ? undefined : handleDrop}
        onFocusCapture={handleFocus}
        onPaste={inputDisabled ? undefined : handlePaste}
        ref={rootRef}
      >
        <ChatDraftAttachmentChips files={attachments} onRemove={removeFile} />
        <div
          className="chat-editor relative min-w-0 overflow-hidden ps-9 pe-3 pt-2 pb-1"
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <Menu>
            <MenuTrigger
              aria-label={t("chat.composerMenu.open")}
              disabled={inputDisabled}
              render={
                <Button
                  className="absolute start-2 top-1.5 rounded-full"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="start" side="top">
              <MenuItem onClick={openFilePicker}>
                <PaperclipIcon />
                {t("chat.attachFile")}
              </MenuItem>
              {onOpenModelSelector && (
                <MenuItem onClick={onOpenModelSelector}>
                  <CpuIcon />
                  {t("chat.composerMenu.models")}
                </MenuItem>
              )}
              {onOpenMcpServers && (
                <MenuItem onClick={onOpenMcpServers}>
                  <ServerIcon />
                  {t("chat.composerMenu.mcpServers")}
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
          <PromptEditorContent
            className={cn(inputDisabled && "pointer-events-none")}
            editor={editor}
          />
          {isEmpty && attachments.length === 0 && (
            <span
              aria-hidden="true"
              className="text-foreground-placeholder pointer-events-none absolute start-9 end-3 top-2 truncate text-sm"
            >
              {placeholder}
            </span>
          )}
        </div>
        <div className="flex items-center justify-end gap-0.5 px-1.5 pb-1.5">
          <input
            accept={fileInputAccept}
            className="hidden"
            disabled={inputDisabled}
            multiple
            onChange={handleFileInputChange}
            ref={fileInputRef}
            type="file"
          />
          <ChatSubmitButton
            canSend={!submitDisabled && canSubmit}
            isGenerating={isGenerating}
            onSend={() => {
              void submitDraft();
            }}
            onStop={onStop}
          />
        </div>
      </div>
      {showStatusRow && (
        <div className="text-muted-foreground mt-1.5 flex items-center justify-between gap-2 px-1 text-xs">
          {statusBarStart}
          {contextUsage && (
            <div className="ms-auto">
              <ChatContextMeter usage={contextUsage} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

type ChatSubmitButtonProps = {
  canSend: boolean;
  isGenerating: boolean;
  onSend: () => void;
  onStop?: (() => void) | undefined;
};

// The single primary affordance morphs in place: the same Button (and DOM node)
// shows the send arrow to submit a draft and the stop square to cancel a running
// turn, so focus state and the icon transition survive the state change.
const ChatSubmitButton = ({
  canSend,
  isGenerating,
  onSend,
  onStop,
}: ChatSubmitButtonProps) => {
  const isStop = isGenerating && onStop !== undefined;

  if (isStop) {
    return (
      <ChatComposerActionButton
        className="bg-foreground text-background hover:bg-foreground/90 shrink-0"
        mode="stop"
        onStop={onStop}
        size="icon-sm"
        variant="default"
      />
    );
  }

  return (
    <ChatComposerActionButton
      canSend={canSend}
      className="bg-foreground text-background hover:bg-foreground/90 shrink-0"
      mode="send"
      onSend={onSend}
      size="icon-sm"
      variant="default"
    />
  );
};
