"use client";

import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ArrowDownIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  StickToBottomContext,
  useMaybeStickToBottomContext,
  useStickToBottom,
  useStickToBottomContext,
} from "@/hooks/use-stick-to-bottom";

type ConversationScrollProviderProps = {
  children: ReactNode;
};

export const ConversationScrollProvider = ({
  children,
}: ConversationScrollProviderProps) => (
  <StickToBottomContext value={useStickToBottom()}>
    {children}
  </StickToBottomContext>
);

type ConversationProps = ComponentProps<"div">;

export const Conversation = ({
  className,
  children,
  ...props
}: ConversationProps) => (
  <div
    className={cn("relative flex-1 overflow-y-hidden", className)}
    role="log"
    {...props}
  >
    {children}
  </div>
);

type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
  className,
  children,
  ...props
}: ConversationContentProps) => {
  const { scrollRef, contentRef } = useStickToBottomContext();

  return (
    // A real scrollbar element (not the browser's native overlay one) so it
    // can win a stacking fight against a docked composer's glass veil that
    // floats over the bottom of the transcript (`DockedComposer` renders its
    // bar stack at z-50) — the native overlay scrollbar painted under
    // `overflow-y-auto` alone renders behind that veil instead of on top of
    // it. `scrollRef`/`contentRef` bind to the real scrolling viewport
    // element exactly as they did on the plain div, so stick-to-bottom
    // tracking is unaffected. On a surface that isolates the transcript's
    // own stacking context (the main /chat page, so sticky headers and the
    // scroll button can't leak above the fade/composer — see
    // `chat-thread-page.tsx`), this scrollbar stays trapped inside that
    // context exactly like the native one did: no behavior change there.
    <ScrollArea scrollbarClassName="z-[60]" viewportRef={scrollRef}>
      <div
        className={cn("flex flex-col gap-8 p-3", className)}
        {...props}
        ref={contentRef}
      >
        {children}
      </div>
    </ScrollArea>
  );
};

type ConversationScrollButtonProps = Omit<
  ComponentProps<typeof Button>,
  "onClick" | "size" | "variant"
>;

/**
 * The scroll-to-bottom action. It lives in the middle of the composer's
 * status row (`ChatComposerDock`), never floating over the transcript or the
 * follow-up chips, so it adds no row and covers nothing. Renders nothing
 * outside a conversation or while the latest message is in view.
 */
export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const t = useTranslations();
  const stickToBottom = useMaybeStickToBottomContext();

  if (
    stickToBottom === null ||
    !stickToBottom.isScrollable ||
    stickToBottom.isAtBottom
  ) {
    return null;
  }

  // The label names the action for people who don't read a bare arrow; a
  // status row narrower than `@md` (a slim side panel) keeps only the arrow.
  return (
    <Button
      aria-label={t("common.scrollToBottom")}
      className={cn("rounded-full before:rounded-full", className)}
      {...props}
      onClick={() => stickToBottom.scrollToBottom()}
      size="xs"
      type="button"
      variant="outline"
    >
      <ArrowDownIcon className="size-3.5" />
      <span aria-hidden="true" className="hidden @md:inline">
        {t("common.scrollToBottom")}
      </span>
    </Button>
  );
};
