import "./chat-editor.css";
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useChatComposerWiring } from "@/components/chat-editor-provider";
import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import {
  ComposerPlusMenu,
  type ComposerModelsMenuProps,
  type ComposerPlusMenuHandle,
} from "@/components/chat/composer-plus-menu";
import { PromptEditorContent } from "@/components/prompt-editor";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";

type ChatInputSurfaceProps = {
  autoFocus?: boolean;
  className?: string;
  controller: ChatEditorController;
  disabled?: boolean;
  /**
   * Editor stature. `compact` (default) is the one-line follow-up bar: an
   * empty composer collapses to a single placeholder line. `large` is the
   * standalone new-chat hero box, holding ~3 text lines of min-height.
   * Both variants keep the (+) at the start of the bottom action row.
   */
  variant?: "compact" | "large";
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
   * Whether this surface will send the next request anonymized, driving
   * the box's blue-ring "shield active" treatment. The surface feeds this
   * from the shared per-thread send-mode store — the same source the dock's
   * shield and the send path read — so the ring can never contradict what
   * gets sent. (The shield toggle itself lives in the dock, not here.)
   */
  anonymized?: boolean;
  /**
   * The slim status row rendered below the bordered box, mounted as one
   * organism (`ChatComposerDock`) so the surface can never hand-assemble
   * — or forget — a control. Omit on surfaces with no status row.
   */
  dock?: ReactNode;
  /**
   * When provided, the (+) menu gains a Models submenu. Omit on surfaces
   * without a model picker.
   */
  models?: ComposerModelsMenuProps | undefined;
  /**
   * When provided, the (+) menu gains a Skills submenu, wired to this
   * surface's own editor. Omit on surfaces without skill insertion
   * (e.g. `activeOrganizationId` is unavailable).
   */
  skillsOrganizationId?: string | undefined;
  /**
   * When provided, the (+) menu gains an MCP Servers submenu. Omit on
   * surfaces that don't navigate to the tools catalogue.
   */
  mcpOrganizationId?: string | undefined;
};

export const ChatInputSurface = ({
  autoFocus,
  className,
  controller,
  disabled = false,
  variant = "compact",
  onSubmit,
  onFocusChange,
  isGenerating = false,
  onStop,
  anonymized = false,
  dock,
  models,
  skillsOrganizationId,
  mcpOrganizationId,
}: ChatInputSurfaceProps) => {
  const t = useTranslations();
  const rootRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<ComposerPlusMenuHandle>(null);
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

  const isBlank = isEmpty && attachments.length === 0;

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
          className="chat-editor relative min-w-0 overflow-hidden ps-3 pe-3 pt-2 pb-1"
          onKeyDown={(event) => {
            // "/" in an empty composer, on a surface with a Skills submenu,
            // opens the (+) menu at Skills instead of typing the character —
            // the composer (+) menu replaces the old slash popover here (see
            // `disableSlashSuggestion` on `useChatEditor`). Modifier
            // combinations and IME composition fall through untouched.
            if (
              skillsOrganizationId !== undefined &&
              isBlank &&
              event.key === "/" &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.nativeEvent.isComposing &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              plusMenuRef.current?.openSkills();
            }
            event.stopPropagation();
          }}
          role="presentation"
        >
          <PromptEditorContent
            // Compact: default to a single text line and grow with content
            // (drop the provider's `min-h-10`), matching the inspector and
            // file-chat bars. Large: hold ~3 text lines (`text-sm` at
            // `leading-5` = 20px per line) so the hero box keeps its
            // stature while empty.
            className={cn(
              variant === "large"
                ? "[&_.ProseMirror]:min-h-15"
                : "[&_.ProseMirror]:min-h-0",
              inputDisabled && "pointer-events-none",
            )}
            editor={editor}
          />
          {isBlank && (
            <span
              aria-hidden="true"
              className="text-foreground-placeholder pointer-events-none absolute start-3 end-3 top-2 truncate text-sm"
            >
              {placeholder}
            </span>
          )}
        </div>
        <div className="flex items-center justify-end gap-0.5 px-1.5 pb-1.5">
          <ComposerPlusMenu
            disabled={inputDisabled}
            mcp={
              mcpOrganizationId
                ? { activeOrganizationId: mcpOrganizationId }
                : undefined
            }
            models={models}
            onOpenFilePicker={openFilePicker}
            onSlashMenuClose={focus}
            ref={plusMenuRef}
            skills={
              skillsOrganizationId
                ? { activeOrganizationId: skillsOrganizationId, editor }
                : undefined
            }
            triggerClassName="me-auto"
          />
          <input
            accept={fileInputAccept}
            className="hidden"
            disabled={inputDisabled}
            multiple
            onChange={handleFileInputChange}
            ref={fileInputRef}
            type="file"
          />
          {/* The single primary affordance morphs in place: the button
              itself resolves send vs. stop from the state it is fed, so
              this surface cannot render a second, parallel control. */}
          <ChatComposerActionButton
            canSend={!submitDisabled && canSubmit}
            isGenerating={isGenerating}
            onSend={() => {
              void submitDraft();
            }}
            onStop={onStop}
          />
        </div>
      </div>
      {dock}
    </div>
  );
};
