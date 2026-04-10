import "./chat-editor.css";
import { useCallback, useEffect } from "react";

import { EditorContent } from "@tiptap/react";
import { ArrowUpIcon, PaperclipIcon } from "lucide-react";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

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
};

// todo: check the code quality
export const ChatInputSurface = ({
  autoFocus,
  className,
  controller,
  disabled = false,
  onSubmit,
}: ChatInputSurfaceProps) => {
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
    openFilePicker,
    removeFile,
    setSubmitHandler,
    submit,
  } = controller;

  const submitDraft = useCallback(async () => {
    if (disabled) {
      return;
    }

    await submit(async (draft) => {
      await onSubmit(draft);
    });
  }, [disabled, onSubmit, submit]);

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

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions
    <div
      className={cn(
        "bg-background rounded-lg border",
        "focus-within:border-ring transition-colors",
        className,
      )}
      onDragOver={disabled ? undefined : handleDragOver}
      onDrop={disabled ? undefined : handleDrop}
      onPaste={disabled ? undefined : handlePaste}
    >
      <ChatDraftAttachmentChips files={attachments} onRemove={removeFile} />
      <div
        className="chat-editor px-3 pt-2 pb-1"
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Button
          disabled={disabled}
          onClick={openFilePicker}
          size="icon-sm"
          variant="ghost"
        >
          <PaperclipIcon className="size-3.5" />
        </Button>
        <input
          accept={fileInputAccept}
          className="hidden"
          disabled={disabled}
          multiple
          onChange={handleFileInputChange}
          ref={fileInputRef}
          type="file"
        />
        <Button
          className={cn(
            "ms-auto shrink-0 transition-colors",
            canSubmit &&
              !disabled &&
              "bg-foreground text-background hover:bg-foreground/90",
          )}
          disabled={disabled || !canSubmit}
          onClick={() => {
            void submitDraft();
          }}
          size="icon-sm"
          variant={canSubmit && !disabled ? "default" : "ghost"}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
};
