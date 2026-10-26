// parser-output-unchanged: moved unchanged from the ingestion parsers' shared-inlines so every parser layer can import it.
/**
 * One line of inline content, trimmed and cut, without losing formatting.
 *
 * A parser that reads a marker off the start of a line ("[12]", "12.")
 * matches it against the line's plain text and then has to remove exactly
 * those characters from an inline tree whose emphasis wrappers may start
 * anywhere. These helpers keep the plain text and the tree on one axis: the
 * text is always `plainTextOf(inlines)`, before and after a cut.
 */

import { type Inline, plainTextOf } from "./document-ast.js";
import { hasInlineChildren } from "./inline.js";

/**
 * Drop the whitespace a prefix cut exposed at the start of an inline
 * list, descending through emphasis wrappers to reach it.
 *
 * Trimming only a top-level text node made a paragraph's plain text
 * depend on where the publisher happened to open a `<b>`: `[1] Text`
 * written flat lost the space after the marker, and the same sentence
 * written as `[1]` plus a bold ` Text` kept it.
 *
 * A leading `line-break` is dropped too. The break was a separator
 * between the marker and the body; once the marker is gone it would open
 * the paragraph with an empty line, and no court paragraph begins with
 * one. The alternative — keeping it as content — would leave the same
 * markup-shape dependence this function exists to remove, since the same
 * document with the break written as `\n` inside a text node loses it.
 */
const trimInlineWhitespace = (
  nodes: readonly Inline[],
  edge: "start" | "end",
): Inline[] => {
  const result = edge === "start" ? [...nodes] : nodes.toReversed();
  // Page anchors passed on the way in: zero-width on the text axis, so
  // neither whitespace to drop nor content that ends the trim.
  const kept: Inline[] = [];

  while (result.length > 0) {
    const first = result[0];
    if (first === undefined) {
      break;
    }

    if (first.type === "line-break") {
      result.shift();
      continue;
    }

    if (first.type === "page-anchor") {
      kept.push(first);
      result.shift();
      continue;
    }

    if (first.type === "text") {
      const trimmed =
        edge === "start" ? first.text.trimStart() : first.text.trimEnd();
      if (trimmed.length > 0) {
        result[0] = { ...first, text: trimmed };
        break;
      }
      result.shift();
      continue;
    }

    // bold | italic | link — trim inside, and drop the wrapper entirely
    // when nothing but whitespace was in it.
    const children = trimInlineWhitespace(first.children, edge);
    if (plainTextOf(children).length > 0) {
      result[0] = { ...first, children };
      break;
    }
    if (children.length > 0) {
      kept.push({ ...first, children });
    }
    result.shift();
  }

  kept.push(...result);
  return edge === "start" ? kept : kept.toReversed();
};

const NORMALIZED_INLINE_LINE = Symbol("normalized-inline-line");

/** Text offsets and rendering share the same trimmed, formatting-preserving tree. */
export const normalizeInlineLine = (nodes: readonly Inline[]) => {
  const inlines = trimInlineWhitespace(
    trimInlineWhitespace(nodes, "start"),
    "end",
  );
  return {
    [NORMALIZED_INLINE_LINE]: true as const,
    inlines,
    plainText: plainTextOf(inlines),
  };
};

export const stripInlineLinePrefix = (
  line: ReturnType<typeof normalizeInlineLine>,
  pattern: RegExp,
) => {
  const match = pattern.exec(line.plainText);
  return {
    match,
    line:
      match === null
        ? line
        : normalizeInlineLine(stripInlinePrefix(line.inlines, match[0].length)),
  };
};

export const stripInlinePrefix = (
  inlines: readonly Inline[],
  charCount: number,
): Inline[] => {
  if (charCount <= 0) {
    return [...inlines];
  }

  const result: Inline[] = [];
  let remaining = charCount;

  for (const node of inlines) {
    if (remaining <= 0) {
      result.push(node);
      continue;
    }

    if (node.type === "text") {
      if (node.text.length <= remaining) {
        remaining -= node.text.length;
      } else {
        const rest = node.text.slice(remaining);
        remaining = 0;
        if (rest) {
          result.push({ ...node, text: rest });
        }
      }
      continue;
    }

    if (node.type === "line-break") {
      remaining -= 1;
      continue;
    }

    if (!hasInlineChildren(node)) {
      // Zero characters on the text axis; passes through untouched.
      result.push(node);
      continue;
    }

    const nodeTextLen = plainTextOf(node.children).length;
    if (nodeTextLen <= remaining) {
      // Entire node consumed by prefix
      remaining -= nodeTextLen;
    } else {
      // Partial strip inside the node
      const stripped = stripInlinePrefix(node.children, remaining);
      remaining = 0;
      if (stripped.length > 0) {
        result.push({ ...node, children: stripped });
      }
    }
  }

  return trimInlineWhitespace(result, "start");
};
