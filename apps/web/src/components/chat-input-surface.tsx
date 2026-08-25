import "./chat-editor.css";
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  ChatSubmitPreservedError,
  useChatComposerWiring,
} from "@/components/chat-editor-provider";
import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import type { ComposerModelsMenuProps } from "@/components/chat/chat-model-options-menu";
import { ChatPromptImproveButton } from "@/components/chat/chat-prompt-improve-button";
import {
  COMPOSER_BOX_ANONYMIZED_CLASS,
  COMPOSER_BOX_CLASS,
  COMPOSER_BOX_FOCUS_CLASS,
  COMPOSER_COMPACT_ROW_CLASS,
  COMPOSER_COMPACT_TEXT_CELL_CLASS,
  COMPOSER_LARGE_ACTION_ROW_CLASS,
  COMPOSER_LARGE_TEXT_WELL_CLASS,
  COMPOSER_LEADING_GROUP_CLASS,
  COMPOSER_PLACEHOLDER_CLASS,
} from "@/components/chat/composer-control-style";
import {
  ComposerPlusMenu,
  type ComposerContextMenuProps,
} from "@/components/chat/composer-plus-menu";
import { PromptEditorContent } from "@/components/prompt-editor";
import { RenderStormRegion } from "@/components/render-storm-canary";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import type { ReservedChatCommandContext } from "@/lib/reserved-chat-commands";

type ChatInputSurfaceProps = {
  autoFocus?: boolean;
  className?: string;
  controller: ChatEditorController;
  disabled?: boolean;
  /** Register this as the canonical main-chat guide surface. Shared and
   * nested chat composers leave this off so tours cannot target duplicates. */
  guideAnchorsEnabled?: boolean;
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
   * Reserved-command availability for this composer's slash menu. Required:
   * every chat composer must declare its context so command availability is
   * decided centrally (`getReservedChatCommands`), never per surface.
   */
  reservedCommands: ReservedChatCommandContext;
  /**
   * When provided, the (+) menu gains a Context submenu (mention a matter
   * or one of its files), wired to this surface's own editor. Omit on
   * surfaces without mention insertion.
   */
  context?: Omit<ComposerContextMenuProps, "editor"> | undefined;
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
  guideAnchorsEnabled = false,
  variant = "compact",
  onSubmit,
  onFocusChange,
  isGenerating = false,
  onStop,
  anonymized = false,
  dock,
  models,
  skillsOrganizationId,
  reservedCommands,
  context,
  mcpOrganizationId,
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
      if (ChatSubmitPreservedError.is(error)) {
        return;
      }
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
    <RenderStormRegion name="chat-composer">
      <div className={cn("flex flex-col", className)}>
        <div
          {...guideAnchor(GUIDE_ANCHORS.chatComposer, guideAnchorsEnabled)}
          className={cn(
            COMPOSER_BOX_CLASS,
            // Default focus border (gray) only when not in anonymized
            // mode — otherwise the gray border landed on top of the
            // blue ring and read as a double-ring on click.
            !inputDisabled && !anonymized && COMPOSER_BOX_FOCUS_CLASS,
            anonymized && COMPOSER_BOX_ANONYMIZED_CLASS,
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
            className={cn(
              variant === "compact" && [
                "grid grid-cols-[auto_minmax(0,1fr)_auto]",
                COMPOSER_COMPACT_ROW_CLASS,
              ],
            )}
          >
            <div
              className={cn(
                "chat-editor overflow-hidden",
                variant === "compact"
                  ? [
                      "col-start-2 row-start-1",
                      COMPOSER_COMPACT_TEXT_CELL_CLASS,
                    ]
                  : ["relative min-w-0", COMPOSER_LARGE_TEXT_WELL_CLASS],
              )}
              onKeyDown={(event) => {
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
                  className={cn(
                    COMPOSER_PLACEHOLDER_CLASS,
                    variant === "compact"
                      ? "start-0 end-0 top-1/2 -translate-y-1/2"
                      : "start-3 end-3 top-2",
                  )}
                >
                  {placeholder}
                </span>
              )}
            </div>
            <div
              className={cn(
                variant === "compact"
                  ? "contents"
                  : COMPOSER_LARGE_ACTION_ROW_CLASS,
              )}
            >
              <div
                className={cn(
                  COMPOSER_LEADING_GROUP_CLASS,
                  variant === "compact"
                    ? "col-start-1 row-start-1 self-end"
                    : "me-auto",
                )}
              >
                <ComposerPlusMenu
                  guideAnchorsEnabled={guideAnchorsEnabled}
                  context={
                    context
                      ? {
                          activeOrganizationId: context.activeOrganizationId,
                          editor,
                          threadRef: context.threadRef,
                        }
                      : undefined
                  }
                  disabled={inputDisabled}
                  mcp={
                    mcpOrganizationId
                      ? { activeOrganizationId: mcpOrganizationId }
                      : undefined
                  }
                  models={models}
                  onOpenFilePicker={openFilePicker}
                  skills={
                    skillsOrganizationId
                      ? {
                          activeOrganizationId: skillsOrganizationId,
                          editor,
                          reservedCommands,
                        }
                      : undefined
                  }
                />
              </div>
              <input
                accept={fileInputAccept}
                className="hidden"
                disabled={inputDisabled}
                multiple
                onChange={handleFileInputChange}
                ref={fileInputRef}
                type="file"
              />
              <div
                className={cn(
                  "flex items-center gap-0.5",
                  variant === "compact" && "col-start-3 row-start-1 self-end",
                )}
              >
                <span className="me-0.5 inline-flex">
                  <ChatPromptImproveButton
                    anonymized={anonymized}
                    controller={controller}
                    disabled={inputDisabled || isBlank}
                  />
                </span>
                {/* The single primary affordance morphs in place: the button
                  itself resolves send vs. stop from the state it is fed, so
                  this surface cannot render a second, parallel control. */}
                <ChatComposerActionButton
                  canSend={!submitDisabled && canSubmit}
                  guideAnchorsEnabled={guideAnchorsEnabled}
                  isGenerating={isGenerating}
                  onSend={() => {
                    detached(submitDraft(), "chat-input-surface.submit-draft");
                  }}
                  onStop={onStop}
                />
              </div>
            </div>
          </div>
        </div>
        {dock}
      </div>
    </RenderStormRegion>
  );
};
