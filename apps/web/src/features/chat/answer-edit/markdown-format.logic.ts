import { panic } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { CompileContext } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  CHAT_MESSAGE_EDIT_FORMAT,
  CHAT_MESSAGE_EDIT_TYPE,
  CHAT_MESSAGE_EDIT_URL_MAX_LENGTH,
} from "@stll/api-contract/chat-message-revisions";
import type { ChatMessageAcceptedEdit } from "@stll/api-contract/chat-message-revisions";

import { markdownTextLeaves } from "@/components/chat/markdown-selection.logic";

type FormatEdit = Extract<
  ChatMessageAcceptedEdit,
  { type: typeof CHAT_MESSAGE_EDIT_TYPE.format }
>;
export type AnswerFormatAction = {
  [Edit in FormatEdit as Edit["format"]]: Omit<Edit, "type" | "start" | "end">;
}[FormatEdit["format"]];

const parseMarkdown = (source: string) =>
  fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
type MarkdownNode = Parameters<CompileContext["enter"]>[0];

const descendants = (root: MarkdownNode) => {
  const nodes: MarkdownNode[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    if ("children" in node) {
      pending.push(...node.children.toReversed());
    }
  }
  return nodes;
};

type SourceSpan = { start: number; end: number };
const sourceSpan = (node: MarkdownNode): SourceSpan | undefined => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end };
};

const visibleNodeSpan = (
  node: MarkdownNode,
  leaves: ReturnType<typeof markdownTextLeaves>,
) => {
  const span = sourceSpan(node);
  if (!span) {
    return undefined;
  }
  const contained = leaves.filter(
    (leaf) => leaf.sourceStart >= span.start && leaf.sourceEnd <= span.end,
  );
  const start = contained.at(0)?.offsets.at(0);
  const end = contained.at(-1)?.offsets.at(-1);
  return start === undefined || end === undefined ? undefined : { start, end };
};

const spansMatch = (left: SourceSpan | undefined, right: SourceSpan) =>
  left?.start === right.start && left.end === right.end;

const unsupported = (
  reason: "ambiguous" | "whole-block-required" | "invalid-url",
) => ({ status: "unsupported", reason }) as const;

// Formatting may create nodes inside the changed span; every container and
// atomic node outside it must retain its kind, bounds and semantic attributes.
const outsideFormatNodes = (source: string, span: SourceSpan, delta: number) =>
  descendants(parseMarkdown(source)).flatMap((node) => {
    const position = sourceSpan(node);
    if (
      !position ||
      node.type === "text" ||
      (position.start >= span.start && position.end <= span.end)
    ) {
      return [];
    }
    return [
      {
        type: node.type,
        start:
          position.start >= span.end ? position.start - delta : position.start,
        end: position.end >= span.end ? position.end - delta : position.end,
        ...("url" in node ? { url: node.url } : {}),
        ...("identifier" in node ? { identifier: node.identifier } : {}),
        ...("depth" in node ? { depth: node.depth } : {}),
        ...("ordered" in node
          ? { ordered: node.ordered, listStart: node.start }
          : {}),
        ...("checked" in node ? { checked: node.checked } : {}),
        ...("align" in node ? { align: node.align } : {}),
      },
    ];
  });

const blockText = (source: string, span: SourceSpan) =>
  descendants(parseMarkdown(source))
    .flatMap((node) => {
      const position = sourceSpan(node);
      if (!position || position.start < span.start || position.end > span.end) {
        return [];
      }
      return node.type === "text" || node.type === "inlineCode"
        ? [node.value]
        : [];
    })
    .join("");

const proposal = ({
  source,
  span,
  replacement,
  action,
}: {
  source: string;
  span: SourceSpan;
  replacement: string;
  action: AnswerFormatAction;
}) => {
  const candidate =
    source.slice(0, span.start) + replacement + source.slice(span.end);
  const delta = replacement.length - (span.end - span.start);
  const before = outsideFormatNodes(source, span, 0);
  const after = outsideFormatNodes(
    candidate,
    { start: span.start, end: span.start + replacement.length },
    delta,
  );
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return unsupported("ambiguous");
  }
  // Block markers can consume text inside the changed span even when every
  // surrounding node is intact. Compare decoded text in the full document so
  // reference links retain their definitions during this check.
  if (
    action.format === CHAT_MESSAGE_EDIT_FORMAT.style &&
    blockText(source, span) !==
      blockText(candidate, {
        start: span.start,
        end: span.start + replacement.length,
      })
  ) {
    return unsupported("ambiguous");
  }
  return {
    status: "proposal" as const,
    start: span.start,
    end: span.end,
    selectedSource: source.slice(span.start, span.end),
    replacement,
    edit: {
      type: CHAT_MESSAGE_EDIT_TYPE.format,
      ...span,
      ...action,
    } satisfies FormatEdit,
  };
};

/** A format may contain existing marks, or sit wholly inside another mark.
 * Crossing only one delimiter would change the formatting of outside words. */
const hasAmbiguousInlineBoundary = (nodes: MarkdownNode[], span: SourceSpan) =>
  nodes.some((node) => {
    const position = sourceSpan(node);
    if (!position || position.end <= span.start || position.start >= span.end) {
      return false;
    }
    if (
      ["code", "inlineCode", "html", "image", "imageReference"].includes(
        node.type,
      )
    ) {
      return true;
    }
    if (
      !["strong", "emphasis", "delete", "link", "linkReference"].includes(
        node.type,
      )
    ) {
      return false;
    }
    return (
      !(span.start >= position.start && span.end <= position.end) &&
      !(span.start <= position.start && span.end >= position.end)
    );
  });

const validLinkUrl = (value: string) => {
  if (
    value.length > CHAT_MESSAGE_EDIT_URL_MAX_LENGTH ||
    /[\r\n\t]/u.test(value) ||
    !/^https?:\/\//u.test(value) ||
    !URL.canParse(value)
  ) {
    return undefined;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  return parsed.href.replace(/[<>\s]/gu, (character) =>
    encodeURIComponent(character),
  );
};

const existingLinkUrl = (node: MarkdownNode, nodes: MarkdownNode[]) => {
  if (node.type === "link") {
    return node.url;
  }
  if (node.type !== "linkReference") {
    return undefined;
  }
  const definition = nodes.find(
    (candidate) =>
      candidate.type === "definition" &&
      candidate.identifier === node.identifier,
  );
  return definition?.type === "definition" ? definition.url : undefined;
};

export const selectedMarkdownLinkUrl = ({
  source,
  start,
  end,
}: SourceSpan & { source: string }) => {
  const nodes = descendants(parseMarkdown(source));
  const leaves = markdownTextLeaves(source);
  const link = nodes.find(
    (node) =>
      (node.type === "link" || node.type === "linkReference") &&
      spansMatch(visibleNodeSpan(node, leaves), { start, end }),
  );
  const url = link ? existingLinkUrl(link, nodes) : undefined;
  return url ? validLinkUrl(url) : undefined;
};

type FormatContext = {
  source: string;
  span: SourceSpan;
  tree: ReturnType<typeof parseMarkdown>;
  nodes: MarkdownNode[];
  leaves: ReturnType<typeof markdownTextLeaves>;
};

const formatBlock = (
  { source, span, tree, leaves }: FormatContext,
  action: Extract<
    AnswerFormatAction,
    { format: typeof CHAT_MESSAGE_EDIT_FORMAT.style }
  >,
) => {
  const block = tree.children.find(
    (node) =>
      spansMatch(visibleNodeSpan(node, leaves), span) ||
      spansMatch(sourceSpan(node), span),
  );
  if (
    !block ||
    (block.type !== "paragraph" &&
      block.type !== "heading" &&
      block.type !== "list")
  ) {
    return unsupported("whole-block-required");
  }
  const position = sourceSpan(block);
  if (!position) {
    return unsupported("whole-block-required");
  }
  if (
    block.type === "list" &&
    block.children.some(
      (item) =>
        item.children.length !== 1 ||
        (item.checked !== null && item.checked !== undefined),
    )
  ) {
    return unsupported("whole-block-required");
  }
  const blocks =
    block.type === "list"
      ? block.children.flatMap((item) => item.children)
      : [block];
  if (
    blocks.some((node) => node.type !== "paragraph" && node.type !== "heading")
  ) {
    return unsupported("whole-block-required");
  }
  const contents: string[] = [];
  for (const node of blocks) {
    if (!("children" in node)) {
      return unsupported("whole-block-required");
    }
    const contentStart = node.children.at(0)?.position?.start.offset;
    const contentEnd = node.children.at(-1)?.position?.end.offset;
    if (contentStart === undefined || contentEnd === undefined) {
      return unsupported("whole-block-required");
    }
    const content = source.slice(contentStart, contentEnd);
    if (/[\r\n]/u.test(content)) {
      return unsupported("whole-block-required");
    }
    contents.push(content);
  }
  const style = action.style;
  let replacement: string;
  switch (style) {
    case "paragraph":
      replacement = contents.join("\n\n");
      break;
    case "ordered-list":
      replacement = contents
        .map((text, index) => `${index + 1}. ${text}`)
        .join("\n");
      break;
    case "unordered-list":
      replacement = contents.map((text) => `- ${text}`).join("\n");
      break;
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
    case "heading-5":
    case "heading-6":
      replacement = contents
        .map((text) => {
          // An unescaped final hash could become an ATX closing marker.
          const content = text.replace(/(^|[^\\])((?:\\\\)*)#$/u, "$1$2\\#");
          return `${"#".repeat(Number(style.slice(-1)))} ${content}`;
        })
        .join("\n\n");
      break;
    default:
      style satisfies never;
      return panic(`Unhandled format style: ${String(style)}`);
  }
  return proposal({ source, span: position, replacement, action });
};

const formatMark = (
  { source, span, nodes, leaves }: FormatContext,
  action: Extract<
    AnswerFormatAction,
    {
      format:
        | typeof CHAT_MESSAGE_EDIT_FORMAT.bold
        | typeof CHAT_MESSAGE_EDIT_FORMAT.italic;
    }
  >,
) => {
  const { start, end } = span;
  const kind =
    action.format === CHAT_MESSAGE_EDIT_FORMAT.bold ? "strong" : "emphasis";
  const enclosing = nodes.findLast(
    (node) =>
      node.type === kind &&
      (sourceSpan(node)?.start ?? Infinity) <= start &&
      (sourceSpan(node)?.end ?? -1) >= end,
  );
  if (enclosing) {
    if (!spansMatch(visibleNodeSpan(enclosing, leaves), span)) {
      return unsupported("ambiguous");
    }
    const position = sourceSpan(enclosing);
    if (!position) {
      return unsupported("ambiguous");
    }
    const width = action.format === CHAT_MESSAGE_EDIT_FORMAT.bold ? 2 : 1;
    return proposal({
      source,
      span: position,
      replacement: source.slice(position.start + width, position.end - width),
      action,
    });
  }
  if (
    hasAmbiguousInlineBoundary(nodes, span) ||
    /[\r\n]/u.test(source.slice(start, end))
  ) {
    return unsupported("ambiguous");
  }
  const selected = source.slice(start, end);
  const leading = selected.slice(
    0,
    selected.length - selected.trimStart().length,
  );
  const trailing = selected.slice(selected.trimEnd().length);
  const body = selected.slice(
    leading.length,
    selected.length - trailing.length,
  );
  if (!body) {
    return unsupported("ambiguous");
  }
  const delimiters =
    action.format === CHAT_MESSAGE_EDIT_FORMAT.bold ? ["**"] : ["_", "*"];
  for (const delimiter of delimiters) {
    const replacement = `${leading}${delimiter}${body}${delimiter}${trailing}`;
    const candidate = source.slice(0, start) + replacement + source.slice(end);
    const matched = descendants(parseMarkdown(candidate)).some(
      (node) =>
        node.type === kind &&
        spansMatch(sourceSpan(node), {
          start: start + leading.length,
          end: start + replacement.length - trailing.length,
        }),
    );
    if (matched) {
      return proposal({ source, span, replacement, action });
    }
  }
  return unsupported("ambiguous");
};

const formatLink = (
  { source, span, nodes, leaves }: FormatContext,
  action: Extract<
    AnswerFormatAction,
    { format: typeof CHAT_MESSAGE_EDIT_FORMAT.link }
  >,
) => {
  const { start, end } = span;
  const url = validLinkUrl(action.url);
  if (!url) {
    return unsupported("invalid-url");
  }
  const enclosing = nodes.find(
    (node) =>
      (node.type === "link" || node.type === "linkReference") &&
      spansMatch(visibleNodeSpan(node, leaves), span),
  );
  const position = enclosing ? sourceSpan(enclosing) : span;
  if (
    !position ||
    hasAmbiguousInlineBoundary(nodes, span) ||
    /[\r\n]/u.test(source.slice(start, end))
  ) {
    return unsupported("ambiguous");
  }
  if (
    !enclosing &&
    nodes.some(
      (node) =>
        (node.type === "link" || node.type === "linkReference") &&
        (sourceSpan(node)?.start ?? Infinity) < end &&
        (sourceSpan(node)?.end ?? -1) > start,
    )
  ) {
    return unsupported("ambiguous");
  }
  let label = source.slice(start, end);
  if (enclosing && "children" in enclosing) {
    const labelStart = enclosing.children.at(0)?.position?.start.offset;
    const labelEnd = enclosing.children.at(-1)?.position?.end.offset;
    if (labelStart === undefined || labelEnd === undefined) {
      return unsupported("ambiguous");
    }
    label = source.slice(labelStart, labelEnd);
  }
  const previousUrl = enclosing ? existingLinkUrl(enclosing, nodes) : undefined;
  if (previousUrl !== undefined && validLinkUrl(previousUrl) === url) {
    let replacement = label;
    // A URL-shaped label can immediately become a GFM autolink again. Escape
    // only reparsed link spans, preserving the label's existing inline marks.
    for (const node of descendants(parseMarkdown(label)).toReversed()) {
      if (node.type !== "link") {
        continue;
      }
      const linkSpan = sourceSpan(node);
      if (!linkSpan) {
        return unsupported("ambiguous");
      }
      replacement =
        replacement.slice(0, linkSpan.start) +
        label.slice(linkSpan.start, linkSpan.end).replace(/[:.@]/gu, "\\$&") +
        replacement.slice(linkSpan.end);
    }
    const candidate =
      source.slice(0, position.start) +
      replacement +
      source.slice(position.end);
    const changedSpan = {
      start: position.start,
      end: position.start + replacement.length,
    };
    if (
      descendants(parseMarkdown(candidate)).some((node) => {
        const nodeSpan = sourceSpan(node);
        return (
          (node.type === "link" || node.type === "linkReference") &&
          nodeSpan !== undefined &&
          nodeSpan.start < changedSpan.end &&
          nodeSpan.end > changedSpan.start
        );
      }) ||
      blockText(source, position) !== blockText(candidate, changedSpan)
    ) {
      return unsupported("ambiguous");
    }
    return proposal({
      source,
      span: position,
      replacement,
      action: { format: CHAT_MESSAGE_EDIT_FORMAT.link, url },
    });
  }
  const replacement = `[${label}](<${url}>)`;
  const candidate =
    source.slice(0, position.start) + replacement + source.slice(position.end);
  const matched = descendants(parseMarkdown(candidate)).some(
    (node) =>
      node.type === "link" &&
      node.url === url &&
      spansMatch(sourceSpan(node), {
        start: position.start,
        end: position.start + replacement.length,
      }),
  );
  return matched
    ? proposal({
        source,
        span: position,
        replacement,
        action: { format: CHAT_MESSAGE_EDIT_FORMAT.link, url },
      })
    : unsupported("ambiguous");
};

type FormatAnswerSpanOptions = SourceSpan & {
  source: string;
  action: AnswerFormatAction;
};

export const formatAnswerSpan = ({
  source,
  start,
  end,
  action,
}: FormatAnswerSpanOptions) => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > source.length ||
    !source.slice(start, end).trim()
  ) {
    return unsupported("ambiguous");
  }
  const span = { start, end };
  const tree = parseMarkdown(source);
  const nodes = descendants(tree);
  const leaves = markdownTextLeaves(source);
  const context = { source, span, tree, nodes, leaves };
  switch (action.format) {
    case CHAT_MESSAGE_EDIT_FORMAT.style:
      return formatBlock(context, action);
    case CHAT_MESSAGE_EDIT_FORMAT.bold:
    case CHAT_MESSAGE_EDIT_FORMAT.italic:
      return formatMark(context, action);
    case CHAT_MESSAGE_EDIT_FORMAT.link:
      return formatLink(context, action);
    default:
      action satisfies never;
      return panic(`Unhandled format action: ${String(action)}`);
  }
};
