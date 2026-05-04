"use client";

import { memo } from "react";
import type { ComponentProps, HTMLAttributes } from "react";

import { cn } from "@stll/ui/lib/utils";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";

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

type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
