"use client";

import { memo, useMemo } from "react";
import type { ComponentType, JSX } from "react";

import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import type { Element, Root, RootContent } from "hast";
import {
  defaultComponents,
  defaultRehypePlugins,
  Streamdown,
} from "streamdown";
import type {
  Components,
  CustomRenderer,
  ExtraProps,
  StreamdownProps,
} from "streamdown";
import type { Pluggable, PluggableList } from "unified";

import { rehypeChatLinks } from "@stll/chat/link-markdown";
import { cn } from "@stll/ui/utils";

import { MermaidDiagramBlock } from "@/components/ai-elements/mermaid-diagram-block";
import { messageComponents } from "@/components/ai-elements/message-response-components";
import { rehypeMarkdownSourceOffsets } from "@/components/chat/rehype-markdown-source-offsets";
import { rehypeScopeAnswerIds } from "@/components/chat/rehype-scope-answer-ids";
import { isSafeMarkdownPreviewImageSrc } from "@/components/markdown-preview.logic";

/*
 * The one renderer for untrusted chat Markdown: model answers, tool results
 * and quoted documents. Rendering never makes the browser fetch anything on
 * its own. Streamdown's raw HTML, sanitize and harden chain always runs first,
 * a caller's plugins only run after it, and the last owned pass removes every
 * element and attribute that would load a resource. Images follow a typed
 * `MessageImagePolicy`, and no policy fetches.
 */

/**
 * How an answer's images render. `alt-text` shows the image's description in
 * its place. `embedded-data` also draws images whose bytes are embedded in the
 * text as a base64 raster `data:` URI, which loads nothing.
 */
export type MessageImagePolicy =
  | { kind: "alt-text" }
  | { kind: "embedded-data" };

type MessageImagePolicyKind = MessageImagePolicy["kind"];

// One frozen value per kind: the policy is plugin options, and Streamdown keys
// its processor cache (and this component its remount key) on them.
const IMAGE_POLICIES = {
  "alt-text": Object.freeze({ kind: "alt-text" }),
  "embedded-data": Object.freeze({ kind: "embedded-data" }),
} as const satisfies {
  [Kind in MessageImagePolicyKind]: Extract<MessageImagePolicy, { kind: Kind }>;
};

const NoResource = () => null;

/**
 * Elements a browser loads something for (a resource, a style sheet, another
 * document) just because they are in the page, each rendered as nothing. The
 * rehype pass removes them; this map is the render-time backstop for plugins
 * Streamdown appends after the owned chain (math). `img` is not listed:
 * images render through the policy. `picture` is unwrapped to its fallback
 * content.
 */
const RESOURCE_ELEMENT_RENDERERS = {
  applet: NoResource,
  audio: NoResource,
  base: NoResource,
  bgsound: NoResource,
  embed: NoResource,
  feimage: NoResource,
  frame: NoResource,
  frameset: NoResource,
  iframe: NoResource,
  image: NoResource,
  link: NoResource,
  meta: NoResource,
  object: NoResource,
  portal: NoResource,
  script: NoResource,
  source: NoResource,
  style: NoResource,
  track: NoResource,
  use: NoResource,
  video: NoResource,
};
// `svg` is removed by the rehype pass only: math draws its glyphs with `svg`
// after that pass, and nothing an answer brought survives to render time.
type ResourceElement = keyof typeof RESOURCE_ELEMENT_RENDERERS | "svg";
const RESOURCE_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(RESOURCE_ELEMENT_RENDERERS),
  "svg",
]);

/**
 * Attributes that make an element fetch, compared lowercased with `-` and `:`
 * removed, so `srcset`, `srcSet` and `xlink:href` match alike. `href` is kept
 * only on links. `style` is dropped whole: `url()`, `image-set()` and
 * `@import` can hide behind CSS escapes.
 */
const RESOURCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "action",
  "archive",
  "background",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "icon",
  "imagesrcset",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcset",
  "style",
  "xlinkhref",
]);

const attributeKey = (property: string): string =>
  property.toLowerCase().replaceAll(/[-:]/gu, "");

const keepsImageSource = (policy: MessageImagePolicy, src: unknown): boolean =>
  policy.kind === "embedded-data" && isSafeMarkdownPreviewImageSrc(src);

const keepsAttribute = (
  tagName: string,
  property: string,
  value: unknown,
  policy: MessageImagePolicy,
): boolean => {
  const key = attributeKey(property);
  if (!RESOURCE_ATTRIBUTES.has(key)) {
    return true;
  }
  if (tagName === "a") {
    return key === "href";
  }
  return tagName === "img" && key === "src" && keepsImageSource(policy, value);
};

const withoutResourceElements = (
  nodes: readonly RootContent[],
  policy: MessageImagePolicy,
): RootContent[] =>
  nodes.flatMap((node): RootContent[] => {
    if (node.type !== "element") {
      return [node];
    }
    const tagName = node.tagName.toLowerCase();
    if (RESOURCE_ELEMENT_NAMES.has(tagName)) {
      return [];
    }
    const children = withoutResourceElements(node.children, policy);
    if (tagName === "picture") {
      return children;
    }
    const properties: Element["properties"] = Object.fromEntries(
      Object.entries(node.properties).filter(([property, value]) =>
        keepsAttribute(tagName, property, value, policy),
      ),
    );
    return [{ ...node, properties, children }];
  });

/**
 * The last owned rehype pass: removes every element and attribute that would
 * load a resource, whichever plugin produced it. A `function` declaration
 * keeps a stable plugin name for Streamdown's processor cache.
 */
export function rehypeNoOutboundResources(policy: MessageImagePolicy) {
  return (tree: Root) => {
    tree.children = withoutResourceElements(tree.children, policy);
  };
}

const policyImage =
  (policy: MessageImagePolicy) =>
  ({ alt, src }: JSX.IntrinsicElements["img"] & ExtraProps) => {
    if (keepsImageSource(policy, src)) {
      return <img alt={alt} src={src} />;
    }
    return alt ? <span>{alt}</span> : null;
  };

const POLICY_IMAGES = {
  "alt-text": policyImage(IMAGE_POLICIES["alt-text"]),
  "embedded-data": policyImage(IMAGE_POLICIES["embedded-data"]),
} as const satisfies Record<MessageImagePolicyKind, unknown>;

/**
 * Element renderers a caller may supply. Resource-loading elements, `img` and
 * `picture` are not among them: the owner renders those. Custom elements (a
 * hyphenated name such as `stll-anon`) stay open for the rehype plugins that
 * add them.
 */
export type MessageComponents = {
  [
    Key in Exclude<
      keyof JSX.IntrinsicElements,
      ResourceElement | "img" | "picture"
    >
  ]?: Components[Key];
} & {
  inlineCode?: Components["inlineCode"];
  [customElement: `${string}-${string}`]:
    | ComponentType<Record<string, unknown> & ExtraProps>
    | undefined;
};

/** Renders an answer's table as Streamdown does; the chart view wraps it. */
export const MessageTable = defaultComponents.table;

const mermaidDiagramRenderer = {
  language: "mermaid",
  component: MermaidDiagramBlock,
} as const satisfies CustomRenderer;

const streamdownPlugins = { cjk, math, renderers: [mermaidDiagramRenderer] };
const EMPTY_REHYPE_PLUGINS = Object.freeze([]);

// Streamdown's raw HTML, sanitize and harden chain.
const SAFETY_PLUGINS: PluggableList = Object.values(defaultRehypePlugins);

/**
 * The sanitize step with `data:` image sources kept, so the resource pass can
 * keep the embedded raster ones. Should Streamdown's sanitize entry change
 * shape, it is returned unchanged and embedded images show their alt text.
 */
const withDataImageSources = (plugin: Pluggable): Pluggable => {
  if (!Array.isArray(plugin)) {
    return plugin;
  }
  const [sanitize, schema] = plugin;
  const protocols: unknown =
    typeof schema === "object" && schema !== null
      ? Reflect.get(schema, "protocols")
      : undefined;
  const sources: unknown =
    typeof protocols === "object" && protocols !== null
      ? Reflect.get(protocols, "src")
      : undefined;
  if (
    typeof schema !== "object" ||
    schema === null ||
    typeof protocols !== "object" ||
    protocols === null ||
    !Array.isArray(sources)
  ) {
    return plugin;
  }
  return [
    sanitize,
    { ...schema, protocols: { ...protocols, src: [...sources, "data"] } },
  ];
};

const SAFETY_PLUGINS_BY_IMAGE_POLICY = {
  "alt-text": SAFETY_PLUGINS,
  "embedded-data": SAFETY_PLUGINS.map((plugin) =>
    plugin === defaultRehypePlugins["sanitize"]
      ? withDataImageSources(plugin)
      : plugin,
  ),
} as const satisfies Record<MessageImagePolicyKind, PluggableList>;

export type MessageResponseProps = Pick<
  StreamdownProps,
  "children" | "className" | "isAnimating"
> & {
  components?: MessageComponents | undefined;
  /** Runs after the owned sanitize chain and before the owned resource pass. */
  rehypePlugins?: PluggableList | undefined;
  sourceOffsets?: boolean | undefined;
  /** Defaults to `alt-text`. */
  imagePolicy?: MessageImagePolicy | undefined;
};

// `<stll-anon>` is injected into the parsed HAST by the
// `rehype-anon-spans` plugin after markdown parsing. Streamdown's
// default sanitisation drops unknown tags, so we whitelist it here
// to let it through. The `ph` attribute carries the placeholder
// the model actually saw (`[PERSON_1]`, …).
const ANON_TAG_ALLOWED: { "stll-anon": string[] } = { "stll-anon": ["ph"] };

export const MessageResponseImpl = memo(
  ({
    className,
    components,
    rehypePlugins,
    sourceOffsets = false,
    imagePolicy,
    ...props
  }: MessageResponseProps) => {
    const imagePolicyKind = imagePolicy?.kind ?? "alt-text";
    const effectiveRehypePlugins = useMemo<PluggableList>(
      () => [
        // Streamdown's raw HTML, sanitize and harden chain always runs first:
        // a caller's `rehypePlugins` only add to it. Replacing it would render
        // raw HTML as literal text and leave link hardening to the components.
        // Ids and names from raw HTML then move into the answer namespace.
        ...SAFETY_PLUGINS_BY_IMAGE_POLICY[imagePolicyKind],
        rehypeScopeAnswerIds,
        ...(rehypePlugins ?? EMPTY_REHYPE_PLUGINS),
        ...(sourceOffsets ? [rehypeMarkdownSourceOffsets] : []),
        rehypeChatLinks,
        // Last, so no earlier plugin (a caller's included) can add a fetch.
        [rehypeNoOutboundResources, IMAGE_POLICIES[imagePolicyKind]],
      ],
      [rehypePlugins, sourceOffsets, imagePolicyKind],
    );
    const effectiveComponents = useMemo(
      () => ({
        ...messageComponents,
        ...components,
        ...RESOURCE_ELEMENT_RENDERERS,
        img: POLICY_IMAGES[imagePolicyKind],
      }),
      [components, imagePolicyKind],
    );
    return (
      // Streamdown's internal memo doesn't compare `rehypePlugins`, so
      // a re-render with a new plugin set is silently skipped and the
      // unified processor is never rebuilt. Tying the key to plugin
      // identity plus tuple options forces a fresh mount whenever the
      // rehype chain actually changes — without this, the anonymization plugin
      // wouldn't run for messages whose children text was identical
      // when first rendered with no plugins.
      <Streamdown
        {...props}
        // Chat content can be any language regardless of the UI locale, so let
        // each message resolve its own direction (Latin -> LTR, Arabic -> RTL)
        // instead of inheriting the RTL shell and reordering Latin punctuation.
        dir="auto"
        key={rehypePluginsKey(effectiveRehypePlugins)}
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
        allowedTags={ANON_TAG_ALLOWED}
        components={effectiveComponents}
        rehypePlugins={effectiveRehypePlugins}
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
    );
  },
  // Children covers streaming text deltas; `isAnimating` marks the last
  // block incomplete and holds code-block actions until the stream settles.
  // Compare the props that matter for downstream features (rehype plugin,
  // components map, image policy, styling) so the wasm pipeline output isn't
  // masked by an over-aggressive memo.
  (prev, next) =>
    prev.children === next.children &&
    prev.isAnimating === next.isAnimating &&
    prev.rehypePlugins === next.rehypePlugins &&
    prev.components === next.components &&
    prev.imagePolicy?.kind === next.imagePolicy?.kind &&
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

const rehypePluginsKey = (rehypePlugins: PluggableList): string => {
  if (rehypePlugins.length === 0) {
    return "no-rehype";
  }
  return `rehype-${JSON.stringify(rehypePlugins.map(keyForPluginEntry))}`;
};

MessageResponseImpl.displayName = "MessageResponseImpl";
