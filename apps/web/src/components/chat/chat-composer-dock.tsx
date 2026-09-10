import type { ReactNode } from "react";

import { panic } from "better-result";
import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ComposerStatusRow } from "@stll/ui/composer";

import {
  ChatContextMeter,
  type ChatContextUsage,
} from "@/components/chat/chat-context-meter";
import type { ComposerModelsMenuProps } from "@/components/chat/chat-model-options-menu";
import { ChatModelSelector } from "@/components/chat/chat-model-selector";
import Tooltip from "@/components/tooltip";
import { ChatAnonymizedToggle } from "@/features/chat/components/chat-anonymized-toggle";
import { ChatWebSearchToggle } from "@/features/chat/components/chat-web-search-toggle";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type ChatComposerDockCommonProps = {
  threadRef: ChatThreadRef;
  guideAnchorsEnabled?: boolean;
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
        endExtras?: ReactNode | undefined;
        models?: ComposerModelsMenuProps | undefined;
      }
  );

type ChatComposerDockRenderState = {
  data: {
    webSearchAvailable: boolean;
    webSearchEnabled: boolean;
    context: ChatContextUsage | null;
  };
  disabled: boolean;
  endExtras: ReactNode | undefined;
  models?: ComposerModelsMenuProps | undefined;
  onNewThread: (() => void) | null;
};

const resolveChatComposerDockRenderState = (
  props: ChatComposerDockProps,
): ChatComposerDockRenderState => {
  switch (props.status) {
    case "pending":
      return {
        data: {
          context: null,
          webSearchAvailable: true,
          webSearchEnabled: false,
        },
        disabled: true,
        endExtras: undefined,
        models: undefined,
        onNewThread: null,
      };
    case "ready":
      return {
        data: props.data,
        disabled: false,
        endExtras: props.endExtras,
        models: props.models,
        onNewThread: props.onNewThread,
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
  const { data, disabled, endExtras, models, onNewThread } =
    resolveChatComposerDockRenderState(props);
  const t = useTranslations();
  const anonymized = useChatAnonymized(threadRef);
  const setAnonymized = useSetChatAnonymized(threadRef);
  return (
    <ComposerStatusRow
      className={className}
      end={
        <div className="flex shrink-0 items-center gap-0.5">
          {onNewThread !== null && (
            <Tooltip
              content={t("chat.newChat")}
              render={
                <Button
                  aria-label={t("chat.newChat")}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onNewThread}
                  size="icon-xs"
                  variant="ghost"
                >
                  <MessageSquarePlusIcon className="size-3.5" />
                </Button>
              }
            />
          )}
          {models && <ChatModelSelector models={models} />}
          {/* The meter renders on every surface: it shows an empty ring
              for a brand-new thread (context null) and fills in once an
              estimate lands. */}
          <ChatContextMeter usage={data.context} />
        </div>
      }
      start={
        // `icon-xs` toggles keep the whole row visually subordinate to
        // the composer input above it: the status row is quiet chrome
        // (muted text-xs, borderless controls), never a second toolbar.
        <div
          className="flex min-w-0 flex-1 items-center gap-1"
          data-slot="chat-composer-dock"
          data-status={props.status}
        >
          {leadingContext}
          {data.webSearchAvailable && (
            <ChatWebSearchToggle
              disabled={disabled}
              enabled={data.webSearchEnabled}
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
