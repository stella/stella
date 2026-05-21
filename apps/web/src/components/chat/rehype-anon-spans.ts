import type { Element, ElementContent, Root, RootContent, Text } from "hast";

import type { ChatAnonRestoration } from "@/components/chat/chat-ui-tools";

/**
 * AST-level highlighter for round-tripped anonymization values.
 * Walks the parsed HAST tree, finds occurrences of each `original`
 * string inside *text* nodes only, and replaces them with a
 * `<stll-anon ph="…">` element so the chat renderer can paint a
 * tooltip-bearing underline.
 *
 * Skipping by parent tag (`a`, `button`, `pre`, `script`,
 * `style`) means the highlight never lands inside links, buttons,
 * or fenced code blocks. Inline `<code>` is fair game.
 */

// Skip interactive containers (the anon pill is tooltip-capable)
// plus block-level code (`pre` wraps fenced code blocks) and
// non-prose containers.
const SKIP_PARENT_TAGS = new Set(["a", "button", "pre", "script", "style"]);

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;

const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

const isElement = (node: ElementContent | RootContent): node is Element =>
  node.type === "element";

const isText = (node: ElementContent | RootContent): node is Text =>
  node.type === "text";

/**
 * Pass `pairs` as the unified options (i.e. use the
 * `[rehypeAnonSpans, pairs]` form) so Streamdown's processor cache
 * keys on `JSON.stringify(pairs)` and two MessageResponse
 * instances with different pair sets get their own processor.
 *
 * `function` declaration with a stable name is required: the
 * cache key uses `plugin.name`, so an anonymous arrow factory
 * collides across all callers.
 */
export function rehypeAnonSpans(
  this: unknown,
  pairs: readonly ChatAnonRestoration[],
) {
  if (pairs.length === 0) {
    return (tree: Root) => tree;
  }

  // Sort by descending length so a placeholder that's a prefix of
  // another (rare but cheap insurance) doesn't get shadowed.
  const sorted = [...pairs].sort(
    (a, b) => b.original.length - a.original.length,
  );
  const lookup = new Map(
    sorted.map((pair) => [pair.original, pair.placeholder]),
  );
  const pattern = new RegExp(
    sorted.map((pair) => escapeRegex(pair.original)).join("|"),
    "gu",
  );

  const splitTextNode = (text: Text): ElementContent[] => {
    const value = text.value;
    const result: ElementContent[] = [];
    let lastEnd = 0;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index > lastEnd) {
        result.push({ type: "text", value: value.slice(lastEnd, match.index) });
      }
      const original = match[0];
      const placeholder = lookup.get(original);
      if (placeholder !== undefined) {
        result.push({
          type: "element",
          tagName: "stll-anon",
          properties: { ph: placeholder },
          children: [{ type: "text", value: original }],
        });
      } else {
        result.push({ type: "text", value: original });
      }
      lastEnd = match.index + original.length;
    }
    if (result.length === 0) {
      return [text];
    }
    if (lastEnd < value.length) {
      result.push({ type: "text", value: value.slice(lastEnd) });
    }
    return result;
  };

  const walkElement = (parent: Element) => {
    const next: ElementContent[] = [];
    for (const child of parent.children) {
      if (isText(child)) {
        if (SKIP_PARENT_TAGS.has(parent.tagName)) {
          next.push(child);
          continue;
        }
        for (const replacement of splitTextNode(child)) {
          next.push(replacement);
        }
        continue;
      }
      if (isElement(child)) {
        if (!SKIP_PARENT_TAGS.has(child.tagName)) {
          walkElement(child);
        }
        next.push(child);
        continue;
      }
      // Comment / Doctype etc. — pass through unchanged.
      next.push(child);
    }
    parent.children = next;
  };

  const walkRoot = (root: Root) => {
    const next: RootContent[] = [];
    for (const child of root.children) {
      if (isText(child)) {
        for (const replacement of splitTextNode(child)) {
          next.push(replacement);
        }
        continue;
      }
      if (isElement(child) && !SKIP_PARENT_TAGS.has(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    root.children = next;
  };

  return (tree: Root) => {
    walkRoot(tree);
    return tree;
  };
}
