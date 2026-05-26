"use client";

import { lazy, Suspense } from "react";
import type { HTMLAttributes } from "react";

import type { UIMessage } from "ai";

import { cn } from "@stll/ui/lib/utils";

import type { MessageResponseProps } from "@/components/ai-elements/message-response";

type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"] | "system";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" && "is-user ms-auto justify-end",
      from === "assistant" && "is-assistant",
      from === "system" && "is-system mx-auto",
      className,
    )}
    {...props}
  />
);

type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit max-w-full min-w-0 flex-col gap-2",
      "overflow-hidden text-sm",
      "group-[.is-user]:ms-auto group-[.is-user]:rounded-lg",
      "group-[.is-user]:bg-secondary group-[.is-user]:px-2.5",
      "group-[.is-user]:bg-secondary group-[.is-user]:py-2",
      "group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      "group-[.is-system]:w-full group-[.is-system]:rounded-lg",
      "group-[.is-system]:border group-[.is-system]:border-dashed",
      "group-[.is-system]:bg-muted/50 group-[.is-system]:px-3",
      "group-[.is-system]:py-2 group-[.is-system]:text-xs",
      "group-[.is-system]:text-muted-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// Streamdown plus its `@streamdown/{cjk,math,mermaid}` plugins drag
// katex (~80 KB gz) and mermaid + cytoscape (~330 KB gz) into the
// bundle. Splitting them behind `lazy()` keeps that weight out of the
// entry chunk — the chunk only loads when an actual chat / AI-response
// surface mounts.
const LazyMessageResponse = lazy(async () => {
  const m = await import("@/components/ai-elements/message-response");
  return { default: m.MessageResponseImpl };
});

const MessageResponseFallback = ({
  children,
  className,
}: MessageResponseProps) => (
  <div className={cn("size-full whitespace-pre-wrap", className)}>
    {children}
  </div>
);

export const MessageResponse = (props: MessageResponseProps) => (
  <Suspense fallback={<MessageResponseFallback {...props} />}>
    <LazyMessageResponse {...props} />
  </Suspense>
);
