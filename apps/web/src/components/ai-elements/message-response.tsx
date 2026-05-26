"use client";

import { memo } from "react";
import type { ComponentProps } from "react";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

import { cn } from "@stll/ui/lib/utils";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, math, mermaid };

// `<stll-anon>` is injected into the parsed HAST by the
// `rehype-anon-spans` plugin after markdown parsing. Streamdown's
// default sanitisation drops unknown tags, so we whitelist it here
// to let it through. The `ph` attribute carries the placeholder
// the model actually saw (`[PERSON_1]`, …).
const ANON_TAG_ALLOWED: { "stll-anon": string[] } = { "stll-anon": ["ph"] };

export const MessageResponseImpl = memo(
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
        // `inline` keeps the loose-list `<p>` next to the list marker
        // (Tailwind would otherwise need to scan streamdown's compiled
        // JS to pick up its own `[&>p]:inline` utility on each `<li>`).
        "[&_li]:my-1 [&_li>p]:my-0 [&_li>p]:inline [&_li>p+p]:mt-2",
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

const isPluginIdentity = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");

const rehypePluginsKey = (
  rehypePlugins: MessageResponseProps["rehypePlugins"],
): string => {
  if (!rehypePlugins || rehypePlugins.length === 0) {
    return "no-rehype";
  }
  const ids = rehypePlugins.map((plugin) => {
    const target: unknown = Array.isArray(plugin) ? plugin.at(0) : plugin;
    if (!isPluginIdentity(target)) {
      return "unknown";
    }
    let id = rehypePluginIds.get(target);
    if (id === undefined) {
      nextRehypePluginId += 1;
      id = nextRehypePluginId;
      rehypePluginIds.set(target, id);
    }
    return id;
  });
  return `rehype-${ids.join("-")}`;
};

MessageResponseImpl.displayName = "MessageResponseImpl";
