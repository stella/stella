import type { ReactNode } from "react";
import { useRef } from "react";

import { panic } from "better-result";
import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ComposerStatusRow } from "@stll/ui/composer";
import { Popover, PopoverPanel } from "@stll/ui/popover";

import {
  ChatContextMeter,
  type ChatContextUsage,
} from "@/components/chat/chat-context-meter";
import type { ComposerModelsMenuProps } from "@/components/chat/chat-model-options-menu";
import { ChatModelSelector } from "@/components/chat/chat-model-selector";
import { ChatAnonymizedToggle } from "@/features/chat/components/chat-anonymized-toggle";
import { ChatWebSearchToggle } from "@/features/chat/components/chat-web-search-toggle";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

/**
 * A question the surface asks before a new thread starts, anchored to the
 * new-chat button. Closing it (Escape, a click outside) calls `onCancel`.
 */
type ChatComposerNewThreadPrompt = {
  content: ReactNode;
  onCancel: () => void;
};

type ChatComposerDockCommonProps = {
  threadRef: ChatThreadRef;
  guideAnchorsEnabled?: boolean;
  /** Model picker rendered beside the context meter when the surface has one. */
  models?: ComposerModelsMenuProps | undefined;
  /**
   * Genuine per-surface leading context, rendered first in the start
   * cluster: the main-chat matter picker, or the file overlay's
   * current-file chip. Surfaces without matter/file scope omit it.
   */
  leadingContext?: ReactNode | undefined;
  /** Row positioning override, forwarded to `ComposerStatusRow`. */
  className?: string | undefined;
};

type ChatComposerDockProps = ChatComposerDockCommonProps &
  (
    | { status: "pending" }
    | {
        status: "ready";
        data: {
          webSearchAvailable: boolean;
          webSearchEnabled: boolean;
          context: ChatContextUsage | null;
        };
        onNewThread: (() => void) | null;
        newThreadPrompt?: ChatComposerNewThreadPrompt | undefined;
        endExtras?: ReactNode | undefined;
      }
  );

type ChatComposerDockRenderState = {
  disabled: boolean;
  endExtras: ReactNode | undefined;
  models?: ComposerModelsMenuProps | undefined;
  onNewThread: (() => void) | null;
  newThreadPrompt: ChatComposerNewThreadPrompt | undefined;
} & (
  | { status: "pending" }
  | {
      status: "ready";
      data: {
        webSearchAvailable: boolean;
        webSearchEnabled: boolean;
        context: ChatContextUsage | null;
      };
    }
);

const resolveChatComposerDockRenderState = (
  props: ChatComposerDockProps,
): ChatComposerDockRenderState => {
  switch (props.status) {
    case "pending":
      return {
        disabled: true,
        endExtras: undefined,
        models: props.models,
        onNewThread: null,
        newThreadPrompt: undefined,
        status: "pending",
      };
    case "ready":
      return {
        data: props.data,
        disabled: false,
        endExtras: props.endExtras,
        models: props.models,
        onNewThread: props.onNewThread,
        newThreadPrompt: props.newThreadPrompt,
        status: "ready",
      };
    default: {
      props satisfies never;
      return panic("Unhandled chat composer dock status");
    }
  }
};

// The one organism that assembles a chat surface's status row. It
// derives the standard controls from the thread session itself and
// renders them through `ComposerStatusRow` in the canonical order
// (context -> globe -> shield -> extras -> new chat -> model -> meter), so every
// surface gets the full set by construction and cannot omit one.
//
// Anonymize source: the shield reads and writes the shared per-thread
// send-mode store keyed by `threadRef` — the same store each surface's
// `getSendMode` transport hook consults. Display and send are therefore
// provably one source, so the shield can never show a state the next
// request won't honour.
export const ChatComposerDock = (props: ChatComposerDockProps) => {
  const {
    className,
    guideAnchorsEnabled = false,
    leadingContext,
    threadRef,
  } = props;
  const renderState = resolveChatComposerDockRenderState(props);
  const { disabled, endExtras, models, newThreadPrompt, onNewThread } =
    renderState;
  const showWebSearch =
    renderState.status === "pending" || renderState.data.webSearchAvailable;
  const webSearchEnabled =
    renderState.status === "ready" && renderState.data.webSearchEnabled;
  const t = useTranslations();
  const anonymized = useChatAnonymized(threadRef);
  const setAnonymized = useSetChatAnonymized(threadRef);
  const newThreadAnchorRef = useRef<HTMLSpanElement>(null);
  return (
    <ComposerStatusRow
      className={className}
      end={
        <div
          aria-hidden={disabled ? true : undefined}
          // Shrinkable, not fixed: in a 320px inspector pane this cluster and
          // the one opposite it are together wider than the row, and a
          // `shrink-0` here would spend the difference on a horizontal
          // scrollbar. The model label truncates instead.
          className="flex min-w-0 items-center gap-0.5"
        >
          {/* An open prompt keeps the button that anchors it, disabled while
              the surface offers no new thread (a rotation is under way). */}
          {(onNewThread !== null || newThreadPrompt !== undefined) && (
            <>
              {/* The anchor wraps the button rather than tracking it, so the
                  button's own click handler stays a plain handler. */}
              <span className="inline-flex" ref={newThreadAnchorRef}>
                <Button
                  aria-label={t("chat.newChat")}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={onNewThread === null}
                  onClick={onNewThread ?? undefined}
                  size="icon-xs"
                  tooltip={t("chat.newChat")}
                  variant="ghost"
                >
                  <MessageSquarePlusIcon className="size-3.5" />
                </Button>
              </span>
              <Popover
                onOpenChange={(open) => {
                  if (!open) {
                    newThreadPrompt?.onCancel();
                  }
                }}
                open={newThreadPrompt !== undefined}
              >
                <PopoverPanel
                  align="end"
                  anchor={newThreadAnchorRef}
                  className="w-72"
                  side="top"
                >
                  {newThreadPrompt?.content}
                </PopoverPanel>
              </Popover>
            </>
          )}
          {models && <ChatModelSelector models={models} />}
          {/* The meter renders on every surface: it shows an empty ring
              for a brand-new thread (context null) and fills in once an
              estimate lands. */}
          {renderState.status === "pending" ? (
            <ChatContextMeter status="pending" />
          ) : (
            <ChatContextMeter status="ready" usage={renderState.data.context} />
          )}
        </div>
      }
      start={
        // `icon-xs` toggles keep the whole row visually subordinate to
        // the composer input above it: the status row is quiet chrome
        // (muted text-xs, borderless controls), never a second toolbar.
        <div
          aria-hidden={disabled ? true : undefined}
          className="flex min-w-0 flex-1 items-center gap-1"
          data-slot="chat-composer-dock"
          data-status={props.status}
        >
          {leadingContext}
          {showWebSearch && (
            <ChatWebSearchToggle
              disabled={disabled}
              enabled={webSearchEnabled}
              size="icon-xs"
              threadRef={threadRef}
            />
          )}
          {/* Wrapper, not the toggle itself: the anchor is registered here so
              the guides slice stays out of the chat feature slice's imports. */}
          <span
            {...guideAnchor(GUIDE_ANCHORS.chatAnonymize, guideAnchorsEnabled)}
            className="inline-flex"
          >
            <ChatAnonymizedToggle
              disabled={disabled}
              enabled={anonymized}
              onChange={setAnonymized}
              size="icon-xs"
            />
          </span>
          {endExtras}
        </div>
      }
    />
  );
};
