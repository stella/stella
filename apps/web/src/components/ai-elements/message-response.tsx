"use client";

import { memo } from "react";
import type { ComponentProps } from "react";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { defaultRehypePlugins, Streamdown } from "streamdown";

import { rehypeChatLinks } from "@stll/chat/link-markdown";
import { cn } from "@stll/ui/utils";

import { mermaidDiagramRenderer } from "@/components/ai-elements/mermaid-diagram-block";
import { messageComponents } from "@/components/ai-elements/message-response-components";
import {
  AnswerBlock,
  answerTreeIdPrefix,
  AnswerTreeIds,
  withAnswerLinkIds,
} from "@/components/ai-elements/message-response-link-ids";
import { rehypeCitationLeadIn } from "@/components/chat/rehype-citation-lead-in";
import { rehypeMarkdownSourceOffsets } from "@/components/chat/rehype-markdown-source-offsets";
import { rehypeNumberAnswerLinks } from "@/components/chat/rehype-number-answer-links";
import { rehypeScopeAnswerIds } from "@/components/chat/rehype-scope-answer-ids";

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  sourceOffsets?: boolean;
};

const streamdownPlugins = { cjk, math, renderers: [mermaidDiagramRenderer] };
const EMPTY_REHYPE_PLUGINS = Object.freeze([]);

// `<stll-anon>` is injected into the parsed HAST by the
// `rehype-anon-spans` plugin after markdown parsing. Streamdown's
// default sanitisation drops unknown tags, so we whitelist it here
// to let it through. The `ph` attribute carries the placeholder
// the model actually saw (`[PERSON_1]`, …).
const ANON_TAG_ALLOWED: { "stll-anon": string[] } = { "stll-anon": ["ph"] };

/**
 * How every rendered answer reads, whatever surface holds it. Streamdown's
 * defaults set a page (headings at 1.7 to 2 times the body); an answer is a
 * few sections of prose, so its headings stay close to the body and spacing,
 * not size, separates them. The body size comes from the surface (16px in
 * the chat thread); headings are fixed steps of the type scale above it.
 */
const ANSWER_TYPOGRAPHY_CLASS_NAME = cn(
  "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  // 12px between blocks. Margins collapse, so a heading's own space above
  // replaces the gap rather than adding to it.
  "space-y-3",
  // An answer never needs a page title: h1 reads as a section heading. One
  // variant per tag, so a surface's own heading override (`[&_h1]:text-xs`)
  // replaces these through `cn` instead of racing them on specificity.
  "[&_h1]:mt-7 [&_h1]:mb-2 [&_h1]:text-lg/6.5 [&_h1]:text-balance",
  "[&_h2]:mt-7 [&_h2]:mb-2 [&_h2]:text-lg/6.5 [&_h2]:text-balance",
  "[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base/6.5 [&_h3]:text-balance",
  "[&_h4]:mt-5 [&_h4]:mb-1.5 [&_h4]:text-base/6.5 [&_h4]:text-balance",
  "[&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:text-sm [&_h5]:text-balance",
  "[&_h6]:mt-4 [&_h6]:mb-1 [&_h6]:text-sm [&_h6]:text-balance",
  // Markers hang outside the text, so wrapped lines align with the first.
  "[&_ol]:list-outside [&_ol]:list-decimal [&_ol]:ps-6",
  "[&_ul]:list-outside [&_ul]:list-disc [&_ul]:ps-6",
  // One 6px step between items at every depth. Streamdown pads each item,
  // and that padding stacked on a nested list's own margins left a much
  // wider gap after a nested list than between two plain items.
  "[&_li]:my-0 [&_li]:py-0 [&_li+li]:mt-1.5",
  "[&_li>:is(ul,ol)]:mt-1.5 [&_li>:is(ul,ol)]:mb-0",
  // `inline` keeps the loose-list `<p>` next to the list marker
  // (Tailwind would otherwise need to scan streamdown's compiled
  // JS to pick up its own `[&>p]:inline` utility on each `<li>`).
  "[&_li>p]:my-0 [&_li>p]:inline [&_li>p+p]:mt-2",
);

export const MessageResponseImpl = memo(
  ({
    className,
    allowedTags,
    components,
    rehypePlugins,
    sourceOffsets = false,
    ...props
  }: MessageResponseProps) => {
    // A settled answer parses as one tree, so the answer names its links;
    // a streamed one names them per block (`AnswerBlock`).
    const parsedWhole = sourceOffsets || props.mode === "static";
    const source = typeof props.children === "string" ? props.children : "";
    const treeIdPrefix = parsedWhole
      ? answerTreeIdPrefix(0, source)
      : undefined;
    const link = components?.a ?? messageComponents.a;
    const effectiveRehypePlugins = [
      // Streamdown's raw HTML, sanitize and harden chain always runs first:
      // a caller's `rehypePlugins` only add to it. Replacing it would render
      // raw HTML as literal text and leave link hardening to the components.
      // Ids and names from raw HTML then move into the answer namespace.
      ...Object.values(defaultRehypePlugins),
      rehypeScopeAnswerIds,
      ...(rehypePlugins ?? EMPTY_REHYPE_PLUGINS),
      ...(sourceOffsets ? [rehypeMarkdownSourceOffsets] : []),
      rehypeChatLinks,
      rehypeCitationLeadIn,
      rehypeNumberAnswerLinks,
    ];
    // Streamdown's internal memo doesn't compare `rehypePlugins`, so
    // a re-render with a new plugin set is silently skipped and the
    // unified processor is never rebuilt. Tying the key to plugin
    // identity plus tuple options forces a fresh mount whenever the
    // rehype chain actually changes — without this, the anonymization plugin
    // wouldn't run for messages whose children text was identical
    // when first rendered with no plugins.
    return (
      <AnswerTreeIds prefix={treeIdPrefix}>
        <Streamdown
          // Chat content can be any language regardless of the UI locale, so let
          // each message resolve its own direction (Latin -> LTR, Arabic -> RTL)
          // instead of inheriting the RTL shell and reordering Latin punctuation.
          dir="auto"
          key={rehypePluginsKey(effectiveRehypePlugins)}
          className={cn(ANSWER_TYPOGRAPHY_CLASS_NAME, className)}
          plugins={streamdownPlugins}
          allowedTags={{ ...ANON_TAG_ALLOWED, ...allowedTags }}
          BlockComponent={AnswerBlock}
          components={{
            ...messageComponents,
            ...components,
            // Links take ids from their place in the answer, so a streamed
            // answer and its reload name them alike.
            a: typeof link === "string" ? link : withAnswerLinkIds(link),
            img: components?.img ?? messageComponents.img,
          }}
          rehypePlugins={effectiveRehypePlugins}
          {...props}
          // Streaming parses each block separately, yielding block-local positions.
          // Settled editable answers need one parse of the unchanged full source.
          {...(sourceOffsets
            ? ({
                mode: "static",
                parseIncompleteMarkdown: false,
                normalizeHtmlIndentation: false,
              } as const)
            : {})}
        />
      </AnswerTreeIds>
    );
  },
  // Children covers streaming text deltas; `isAnimating` marks the last
  // block incomplete and holds code-block actions until the stream settles.
  // Compare the props that matter for downstream features (rehype plugin,
  // components map, styling) so the wasm pipeline output isn't masked by an
  // over-aggressive memo.
  (prev, next) =>
    prev.children === next.children &&
    prev.isAnimating === next.isAnimating &&
    prev.rehypePlugins === next.rehypePlugins &&
    prev.components === next.components &&
    prev.allowedTags === next.allowedTags &&
    prev.sourceOffsets === next.sourceOffsets &&
    prev.className === next.className,
);

const rehypePluginIds = new WeakMap<object, number>();
let nextRehypePluginId = 0;

const isPluginIdentity = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");

const isPluginTuple = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const keyForPluginValue = (value: unknown): string => {
  if (!isPluginIdentity(value)) {
    return `value:${typeof value}:${String(value)}`;
  }
  let id = rehypePluginIds.get(value);
  if (id === undefined) {
    nextRehypePluginId += 1;
    id = nextRehypePluginId;
    rehypePluginIds.set(value, id);
  }
  return `ref:${id}`;
};

const keyForPluginEntry = (plugin: unknown): string => {
  if (!isPluginTuple(plugin)) {
    return keyForPluginValue(plugin);
  }
  const pluginIdentity = plugin.at(0);
  const pluginOptions = plugin.slice(1);
  return JSON.stringify([
    keyForPluginValue(pluginIdentity),
    ...pluginOptions.map(keyForPluginValue),
  ]);
};

const rehypePluginsKey = (
  rehypePlugins: MessageResponseProps["rehypePlugins"],
): string => {
  if (!rehypePlugins || rehypePlugins.length === 0) {
    return "no-rehype";
  }
  return `rehype-${JSON.stringify(rehypePlugins.map(keyForPluginEntry))}`;
};

MessageResponseImpl.displayName = "MessageResponseImpl";
