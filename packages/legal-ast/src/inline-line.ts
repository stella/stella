// parser-output-unchanged: only the sk-us parser calls rewriteInlineWhitespace, and its version is bumped; every other parser reaches only the unchanged helpers in this file.
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

// parser-output-unchanged: adds stripInlineSuffix, mapInlineText and rewriteInlineWhitespace; the existing helpers are unchanged.
/**
 * Cut `charCount` characters off the end of an inline list, descending
 * through emphasis wrappers to reach them, and drop the whitespace the cut
 * exposed. The mirror of {@link stripInlinePrefix}: a marker printed at the
 * end of a line (a page number after the last word) leaves the same tree it
 * would have had without it.
 */
export const stripInlineSuffix = (
  inlines: readonly Inline[],
  charCount: number,
): Inline[] => {
  const result = [...inlines];
  let remaining = charCount;
  for (let index = result.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const node = result[index];
    if (node === undefined) {
      continue;
    }
    const length = plainTextOf([node]).length;
    if (length === 0) {
      // Zero characters on the text axis (a page anchor); kept where it is.
      continue;
    }
    if (length <= remaining) {
      remaining -= length;
      result.splice(index, 1);
      continue;
    }
    if (node.type === "text") {
      result[index] = { ...node, text: node.text.slice(0, -remaining) };
    } else if (hasInlineChildren(node)) {
      result[index] = {
        ...node,
        children: stripInlineSuffix(node.children, remaining),
      };
    }
    remaining = 0;
  }
  return trimInlineWhitespace(result, "end");
};

/** The same inline tree with every text node's text passed through `map`. */
export const mapInlineText = (
  inlines: readonly Inline[],
  map: (text: string) => string,
): Inline[] =>
  inlines.map((node): Inline => {
    if (node.type === "text") {
      return { ...node, text: map(node.text) };
    }
    return hasInlineChildren(node)
      ? { ...node, children: mapInlineText(node.children, map) }
      : node;
  });

const isWhitespace = (char: string | undefined): boolean =>
  char !== undefined && /^\s$/u.test(char);

/**
 * What each character of `before` becomes in `after`: itself, other
 * whitespace, or nothing. `undefined` when `after` is not `before` with only
 * whitespace removed or replaced.
 */
const whitespaceEdits = (
  before: string,
  after: string,
): string[] | undefined => {
  const kept: string[] = [];
  let next = 0;
  // Code units, not code points: the offsets below are a text node's length.
  const source = before.split("");
  for (const [index, char] of source.entries()) {
    const target = after[next];
    const laterExactWhitespace =
      isWhitespace(char) &&
      isWhitespace(target) &&
      char !== target &&
      source
        .slice(index + 1)
        .find((later) => !isWhitespace(later) || later === target) === target;
    if (
      char === target ||
      (isWhitespace(char) && isWhitespace(target) && !laterExactWhitespace)
    ) {
      kept.push(target ?? "");
      next += 1;
    } else if (isWhitespace(char)) {
      kept.push("");
    } else {
      return undefined;
    }
  }
  return next === after.length ? kept : undefined;
};

/**
 * Apply a rewrite of a line's whole text that only removes whitespace or
 * replaces it with other whitespace, and keep the inline tree it came from.
 *
 * A rewrite that reads across words (letter-spaced emphasis) has to see the
 * line as one text: run node by node, a wrapper's edge reads as the edge of
 * the line, and `k e` beside `lektronickému` would be judged without the
 * word it touches. The edit is read back onto the tree by aligning the two
 * texts; a rewrite that changes anything but whitespace leaves the tree as
 * it was.
 */
export const rewriteInlineWhitespace = (
  inlines: readonly Inline[],
  rewrite: (text: string) => string,
): Inline[] => {
  const before = plainTextOf(inlines);
  const after = rewrite(before);
  const kept = after === before ? undefined : whitespaceEdits(before, after);
  if (kept === undefined) {
    return [...inlines];
  }
  let offset = 0;
  const apply = (nodes: readonly Inline[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if (node.type === "text") {
        const text = kept.slice(offset, offset + node.text.length).join("");
        offset += node.text.length;
        return text.length === 0 ? [] : [{ ...node, text }];
      }
      if (node.type === "line-break") {
        const text = kept[offset] ?? "";
        offset += 1;
        if (text === "\n") {
          return [node];
        }
        return text.length === 0 ? [] : [{ type: "text", text }];
      }
      return hasInlineChildren(node)
        ? [{ ...node, children: apply(node.children) }]
        : [node];
    });
  return apply(inlines);
};
