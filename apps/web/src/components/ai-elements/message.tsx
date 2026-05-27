"use client";

import { lazy, Suspense } from "react";
import type { HTMLAttributes, ReactNode } from "react";

import type { UIMessage } from "ai";

import { WandSparklesIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { SKILL_REF_HASH_PREFIX } from "@/components/chat/streamdown-mention-link";
import { InlinePill } from "@/components/inline-pill";

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

// Skill chip markdown link: `[label](#stella-skill-ref=slug)`. We
// inline-render these as placeholder `<InlinePill>`s during the
// Streamdown lazy-chunk load, so the raw `[...](#stella-skill-ref=...)`
// source never paints between the composer chip leaving and the
// transcript `SkillRefChip` arriving. The placeholder's visual
// shape matches the real chip, so no second flash when Streamdown
// finishes parsing. Prefix is imported from the chip module so a
// rename of `SKILL_REF_HASH_PREFIX` invalidates this matcher at
// compile time instead of silently leaving raw markdown to flash.
const SKILL_LINK_RE = new RegExp(
  `\\[([^\\]]+)]\\(${SKILL_REF_HASH_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^)]+)\\)`,
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
    nodes.push(
      <InlinePill
        key={`${match.index}-${match[2] ?? ""}`}
        leadingIcon={<WandSparklesIcon className="size-3 shrink-0" />}
        truncate
      >
        {label}
      </InlinePill>,
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
  <div className={cn("size-full whitespace-pre-wrap", className)}>
    {renderFallbackChildren(children)}
  </div>
);

export const MessageResponse = (props: MessageResponseProps) => (
  <Suspense fallback={<MessageResponseFallback {...props} />}>
    <LazyMessageResponse {...props} />
  </Suspense>
);
