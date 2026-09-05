"use client";

import type { ComponentProps, ReactNode } from "react";

import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  SuggestedActionSurface,
  type SuggestedActionSurfaceName,
} from "@/components/suggested-actions";
import {
  StickToBottomContext,
  useStickToBottom,
  useStickToBottomContext,
} from "@/hooks/use-stick-to-bottom";
import { downloadFile } from "@/lib/utils";

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

type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {Boolean(icon) && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

type ConversationScrollButtonBaseProps = Omit<
  ComponentProps<typeof Button>,
  "onClick" | "size" | "variant"
>;

type ConversationScrollButtonProps = ConversationScrollButtonBaseProps &
  (
    | { placement?: "floating"; surface?: never }
    | {
        placement: "inline";
        surface: Extract<SuggestedActionSurfaceName, "plain" | "overlay">;
      }
  );

/**
 * Whether the scroll-to-bottom action shows. Exported so a row that overlays
 * the inline action can reserve its footprint under the same rule.
 */
export const isScrollActionVisible = ({
  isAtBottom,
  isScrollable,
}: {
  isAtBottom: boolean;
  isScrollable: boolean;
}) => isScrollable && !isAtBottom;

export const ConversationScrollButton = ({
  className,
  placement = "floating",
  surface = "plain",
  ...props
}: ConversationScrollButtonProps) => {
  const t = useTranslations();
  const { isAtBottom, isScrollable, scrollToBottom } =
    useStickToBottomContext();
  const isVisible = isScrollActionVisible({ isAtBottom, isScrollable });

  if (!isVisible && placement === "floating") {
    return null;
  }

  const button = (
    <Button
      aria-label={t("common.scrollToBottom")}
      className={cn(
        "before:rounded-full",
        placement === "floating"
          ? [
              // The outline variant is translucent in dark mode (content
              // shows through the button). Pin an opaque surface in both
              // themes; isolate/z-10 keep it above the scrolled content.
              "bg-background dark:bg-background hover:bg-muted",
              "isolate shadow-sm",
              "absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full",
            ]
          : "size-full rounded-full sm:size-full",
        className,
      )}
      {...props}
      onClick={() => scrollToBottom()}
      size={placement === "floating" ? "icon" : "icon-sm"}
      type="button"
      variant={
        placement === "floating" || surface === "plain" ? "outline" : "ghost"
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );

  if (placement !== "inline") {
    return button;
  }

  // `size-7` matches the suggested-action chips beside it. `className` lands
  // on the slot, not the button: the caller positions the slot in its row.
  return (
    <SuggestedActionSurface
      aria-hidden={!isVisible || undefined}
      className={cn("size-7 shrink-0", !isVisible && "invisible", className)}
      surface={surface}
    >
      {isVisible && button}
    </SuggestedActionSurface>
  );
};

type ConversationMessage = {
  role: "user" | "assistant" | "system" | "data" | "tool";
  content: string;
};

type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: ConversationMessage[];
  filename?: string;
  formatMessage?: (message: ConversationMessage, index: number) => string;
};

const defaultFormatMessage = (message: ConversationMessage): string => {
  const roleLabel =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${message.content}`;
};

const messagesToMarkdown = (
  messages: ConversationMessage[],
  formatMessage: (
    message: ConversationMessage,
    index: number,
  ) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = () => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    downloadFile(new Blob([markdown], { type: "text/markdown" }), filename);
  };

  return (
    <Button
      className={cn(
        "dark:bg-background dark:hover:bg-muted",
        "absolute",
        "inset-e-4 top-4 rounded-full",
        className,
      )}
      size="icon"
      type="button"
      variant="outline"
      {...props}
      // After the spread on purpose: the props type omits `onClick` so the
      // button keeps its download action, but an omit only rejects a literal
      // attribute. A props object typed wider stays assignable and carries a
      // handler through the spread, silently replacing the download.
      onClick={handleDownload}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
