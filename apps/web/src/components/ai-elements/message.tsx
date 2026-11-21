"use client";

import { lazy, Suspense } from "react";
import type { HTMLAttributes, ReactNode } from "react";

import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";
import { cn } from "@stll/ui/utils";

import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import {
  MESSAGE_CONTENT_CLASS,
  type MessageAuthor,
  messageClassName,
} from "@/components/ai-elements/message.pending";
import { ReferenceChip } from "@/components/references/reference-chip";

type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageAuthor;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div className={cn(messageClassName(from), className)} {...props} />
);

type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div className={cn(MESSAGE_CONTENT_CLASS, className)} {...props}>
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

// Skill chip markdown link: `[label](#stella-skill-ref=slug)`. We
// inline-render these as the shared `<ReferenceChip>` during the
// Streamdown lazy-chunk load, so the raw `[...](#stella-skill-ref=...)`
// source never paints between the composer chip leaving and the
// transcript's chip arriving. It is the same component the parsed
// markdown renders, so no second flash when Streamdown finishes parsing. The prefix comes from its @stll/api-contract owner,
// so this matcher cannot drift from the chip writer and the API reader.
const SKILL_LINK_RE = new RegExp(
  `\\[([^\\]]+)\\]\\(${SKILL_REF_HREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^)]+)\\)`,
  "gu",
);

const renderFallbackChildren = (children: ReactNode): ReactNode => {
  if (typeof children !== "string") {
    return children;
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  // Reset between calls: `RegExp.exec` with `g` keeps lastIndex
  // across invocations of the same regex instance.
  SKILL_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = SKILL_LINK_RE.exec(children);
  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(children.slice(cursor, match.index));
    }
    const label = match[1] ?? "";
    const slug = match[2] ?? "";
    nodes.push(
      <ReferenceChip
        interactive={false}
        key={`${match.index}-${slug}`}
        reference={{ type: "skill", slug, label }}
      />,
    );
    cursor = match.index + match[0].length;
    match = SKILL_LINK_RE.exec(children);
  }
  if (nodes.length === 0) {
    return children;
  }
  if (cursor < children.length) {
    nodes.push(children.slice(cursor));
  }
  return nodes;
};

const MessageResponseFallback = ({
  children,
  className,
}: MessageResponseProps) => (
  <div className={cn("size-full whitespace-pre-wrap", className)} dir="auto">
    {renderFallbackChildren(children)}
  </div>
);

type MessageResponsePropsWithFallback = Omit<
  MessageResponseProps,
  "children"
> & {
  children: string;
  fallbackChildren?: string | undefined;
};

export const MessageResponse = ({
  children,
  fallbackChildren,
  ...props
}: MessageResponsePropsWithFallback) => (
  <Suspense
    fallback={
      <MessageResponseFallback {...props}>
        {fallbackChildren ?? children}
      </MessageResponseFallback>
    }
  >
    <LazyMessageResponse {...props}>{children}</LazyMessageResponse>
  </Suspense>
);
