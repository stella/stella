import "./chat-editor.css";
import { useCallback, useEffect } from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { EditorContent } from "@tiptap/react";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";

type ChatInputSurfaceProps = {
  autoFocus?: boolean;
  className?: string;
  controller: ChatEditorController;
  disabled?: boolean;
  onSubmit: (draft: ChatInputDraft) => Promise<void> | void;
  /**
   * When set, the surface renders an in-line stop button while
   * generating instead of the send affordance, replacing the need
   * for a separate Stop button next to the input.
   */
  isGenerating?: boolean;
  onStop?: () => void;
};

// todo: check the code quality
export const ChatInputSurface = ({
  autoFocus,
  className,
  controller,
  disabled = false,
  onSubmit,
  isGenerating = false,
  onStop,
}: ChatInputSurfaceProps) => {
  const t = useTranslations();
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
    setSubmitHandler,
    submit,
  } = controller;
  const inputDisabled = disabled || isGenerating;

  const submitDraft = useCallback(async () => {
    // While the assistant is streaming we render Stop in place of
    // Send, but Enter still calls submit unless we gate it here.
    // Without this guard, a user pressing Enter during a turn fires
    // an overlapping `sendMessage` and the two responses interleave.
    if (inputDisabled) {
      return;
    }

    await submit(async (draft) => {
      await onSubmit(draft);
    });
  }, [inputDisabled, onSubmit, submit]);

  useEffect(() => {
    setSubmitHandler(submitDraft);
    return () => {
      setSubmitHandler(null);
    };
  }, [setSubmitHandler, submitDraft]);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }

    focus();
  }, [autoFocus, focus]);

  useEffect(() => {
    editor?.setEditable(!inputDisabled);
    if (inputDisabled) {
      editor?.commands.blur();
    }
  }, [editor, inputDisabled]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions
    <div
      className={cn(
        "bg-background rounded-lg border",
        "transition-colors",
        !inputDisabled && "focus-within:border-ring",
        className,
      )}
      onDragOver={inputDisabled ? undefined : handleDragOver}
      onDrop={inputDisabled ? undefined : handleDrop}
      onPaste={inputDisabled ? undefined : handlePaste}
    >
      <ChatDraftAttachmentChips files={attachments} onRemove={removeFile} />
      <div
        className="chat-editor relative px-3 pt-2 pb-1"
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <EditorContent
          className={cn(inputDisabled && "pointer-events-none")}
          editor={editor}
        />
        {isEmpty && attachments.length === 0 && (
          <span
            aria-hidden="true"
            className="text-muted-foreground/64 pointer-events-none absolute start-3 top-2 text-sm"
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
              (inputDisabled || !canSubmit) && "opacity-50",
            )}
            disabled={inputDisabled || !canSubmit}
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
