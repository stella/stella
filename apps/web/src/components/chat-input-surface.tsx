import "./chat-editor.css";
import { useCallback, useEffect, useRef } from "react";

import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useChatComposerWiring } from "@/components/chat-editor-provider";
import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import { PromptEditorContent } from "@/components/prompt-editor";

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
    removeFile,
  } = controller;
  const inputDisabled = disabled;
  // While the assistant is streaming we render Stop in place of Send,
  // but Enter still calls submit unless we gate it here. Without this
  // guard, a user pressing Enter during a turn fires an overlapping
  // `sendMessage` and the two responses interleave.
  const submitDisabled = disabled || isGenerating;

  const { submitDraft } = useChatComposerWiring({
    controller,
    inputDisabled,
    onSubmit,
    submitDisabled,
  });

  useEffect(() => {
    if (!autoFocus) {
      return;
    }

    focus();
  }, [autoFocus, focus]);

  const handleFocus = useCallback(() => {
    onFocusChange?.(true);
  }, [onFocusChange]);

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) {
        return;
      }

      onFocusChange?.(false);
    },
    [onFocusChange],
  );

  return (
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
        className,
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
        className="chat-editor relative px-3 pt-2 pb-1"
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <PromptEditorContent
          className={cn(inputDisabled && "pointer-events-none")}
          editor={editor}
        />
        {isEmpty && attachments.length === 0 && (
          <span
            aria-hidden="true"
            className="text-foreground-placeholder pointer-events-none absolute start-3 top-2 text-sm"
          >
            {t("chat.placeholder")}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Button
          disabled={inputDisabled}
          onClick={openFilePicker}
          size="icon-sm"
          variant="ghost"
        >
          <PaperclipIcon className="size-3.5" />
        </Button>
        <input
          accept={fileInputAccept}
          className="hidden"
          disabled={inputDisabled}
          multiple
          onChange={handleFileInputChange}
          ref={fileInputRef}
          type="file"
        />
        {isGenerating && onStop ? (
          <Button
            className="ms-auto shrink-0"
            onClick={onStop}
            size="icon-sm"
            variant="outline"
          >
            <SquareIcon className="size-3.5" />
          </Button>
        ) : (
          <Button
            className={cn(
              "bg-foreground text-background hover:bg-foreground/90 ms-auto shrink-0",
              (submitDisabled || !canSubmit) && "opacity-50",
            )}
            disabled={submitDisabled || !canSubmit}
            onClick={() => {
              void submitDraft();
            }}
            size="icon-sm"
            variant="default"
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
};
