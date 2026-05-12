"use client";

import { memo } from "react";
import type { ComponentProps, HTMLAttributes } from "react";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";

import { cn } from "@stll/ui/lib/utils";

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

// `<stll-anon>` is injected into the parsed HAST by the
// `rehype-anon-spans` plugin after markdown parsing. Streamdown's
// default sanitisation drops unknown tags, so we whitelist it here
// to let it through. The `ph` attribute carries the placeholder
// the model actually saw (`[PERSON_1]`, …).
const ANON_TAG_ALLOWED: { "stll-anon": string[] } = { "stll-anon": ["ph"] };

export const MessageResponse = memo(
  ({
    className,
    allowedTags,
    rehypePlugins,
    ...props
  }: MessageResponseProps) => (
    // Streamdown's internal memo doesn't compare `rehypePlugins`, so
    // a re-render with a new plugin set is silently skipped and the
    // unified processor is never rebuilt. Tying the key to plugin
    // identity (defined/undefined plus a counter for distinct
    // arrays) forces a fresh mount whenever the rehype chain
    // actually changes — without this, the anonymization plugin
    // wouldn't run for messages whose children text was identical
    // when first rendered with no plugins.
    <Streamdown
      key={rehypePluginsKey(rehypePlugins)}
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-5",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-5",
        "[&_li]:my-1 [&_li>p]:my-0 [&_li>p+p]:mt-2",
        className,
      )}
      plugins={streamdownPlugins}
      allowedTags={{ ...ANON_TAG_ALLOWED, ...allowedTags }}
      {...(rehypePlugins ? { rehypePlugins } : {})}
      {...props}
    />
  ),
  // Children covers streaming text deltas. Compare the props that
  // matter for downstream features (rehype plugin, components map,
  // styling) so the wasm pipeline output isn't masked by an over-
  // aggressive memo.
  (prev, next) =>
    prev.children === next.children &&
    prev.rehypePlugins === next.rehypePlugins &&
    prev.components === next.components &&
    prev.allowedTags === next.allowedTags &&
    prev.className === next.className,
);

const rehypePluginIds = new WeakMap<object, number>();
let nextRehypePluginId = 0;
const rehypePluginsKey = (
  rehypePlugins: MessageResponseProps["rehypePlugins"],
): string => {
  if (!rehypePlugins) {
    return "no-rehype";
  }
  let id = rehypePluginIds.get(rehypePlugins);
  if (id === undefined) {
    nextRehypePluginId += 1;
    id = nextRehypePluginId;
    rehypePluginIds.set(rehypePlugins, id);
  }
  return `rehype-${id}`;
};

MessageResponse.displayName = "MessageResponse";
