"use client";

import { useCallback } from "react";
import type { ComponentProps, ReactNode } from "react";

import { ArrowDownIcon, DownloadIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import {
  StickToBottomContext,
  useStickToBottom,
  useStickToBottomContext,
} from "@/hooks/use-stick-to-bottom";

type ConversationProps = ComponentProps<"div">;

export const Conversation = ({
  className,
  children,
  ...props
}: ConversationProps) => {
  const stickToBottom = useStickToBottom();

  return (
    <StickToBottomContext value={stickToBottom}>
      <div
        className={cn("relative flex-1 overflow-y-hidden", className)}
        role="log"
        {...props}
      >
        {children}
      </div>
    </StickToBottomContext>
  );
};

type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
  className,
  children,
  ...props
}: ConversationContentProps) => {
  const { scrollRef, contentRef } = useStickToBottomContext();

  return (
    <div
      ref={scrollRef}
      className="size-full overflow-y-auto"
      style={{ scrollbarGutter: "stable both-edges" }}
    >
      <div
        className={cn("flex flex-col gap-8 p-3", className)}
        {...props}
        ref={contentRef}
      >
        {children}
      </div>
    </div>
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

type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, isScrollable, scrollToBottom } =
    useStickToBottomContext();

  return (
    isScrollable &&
    !isAtBottom && (
      <div className="bg-background absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full">
        <Button
          className={cn("rounded-full", className)}
          onClick={() => scrollToBottom()}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    )
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
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "dark:bg-background dark:hover:bg-muted",
        "absolute",
        "inset-e-4 top-4 rounded-full",
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
