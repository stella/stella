import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export const normalizeMarkdownSelectionText = (text: string) =>
  text.replace(/\s+/gu, " ").trim();

type MarkdownTextLeaf = {
  text: string;
  offsets: number[];
  sourceStart: number;
  sourceEnd: number;
};

// Keep UTF-16 offsets: DOM Range and the revision endpoint both index JS strings.
const decodeTextOffsets = (raw: string, start: number): MarkdownTextLeaf => {
  let text = "";
  const offsets = [start];
  for (let index = 0; index < raw.length;) {
    const remaining = raw.slice(index);
    const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/u.exec(
      remaining,
    );
    const entity = /^&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/iu
      .exec(remaining)
      ?.at(0);
    let value = raw.charAt(index);
    let width = 1;
    if (escaped) {
      value = escaped.at(1) ?? value;
      width = escaped[0].length;
    } else if (entity) {
      const parsed = fromMarkdown(entity).children.at(0);
      const child =
        parsed && "children" in parsed ? parsed.children.at(0) : undefined;
      if (child?.type === "text") {
        value = child.value;
        width = entity.length;
      }
    } else if (raw.startsWith("\r\n", index)) {
      value = "\n";
      width = 2;
    } else if (value === "\r") {
      value = "\n";
    }
    text += value;
    for (let unit = 1; unit <= value.length; unit += 1) {
      offsets.push(start + index + (unit === value.length ? width : 0));
    }
    index += width;
  }
  return { text, offsets, sourceStart: start, sourceEnd: start + raw.length };
};

export const markdownTextLeaves = (source: string): MarkdownTextLeaf[] => {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const leaves: MarkdownTextLeaf[] = [];
  const nodes = tree.children.toReversed();
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    if ("children" in node) {
      nodes.push(...node.children.toReversed());
      continue;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    if (node.type === "text") {
      const leaf = decodeTextOffsets(source.slice(start, end), start);
      if (leaf.text === node.value) {
        leaves.push(leaf);
      }
      continue;
    }
    if (node.type === "inlineCode") {
      const raw = source.slice(start, end);
      const delimiter = /^`+/u.exec(raw)?.at(0);
      if (!delimiter) {
        continue;
      }
      const contentStart = start + delimiter.length;
      const content = raw
        .slice(delimiter.length, -delimiter.length)
        .replace(/\r\n|\r|\n/gu, " ");
      const trim =
        content.startsWith(" ") &&
        content.endsWith(" ") &&
        /[^ ]/u.test(content)
          ? 1
          : 0;
      const text = trim ? content.slice(1, -1) : content;
      if (text !== node.value || raw.includes("\r")) {
        continue;
      }
      leaves.push({
        text,
        sourceStart: start,
        sourceEnd: end,
        offsets: Array.from(
          { length: text.length + 1 },
          (_, index) => contentStart + trim + index,
        ),
      });
    }
  }
  return leaves;
};

/** Strip only syntax identified by the full document parser, including spans
 * whose selection starts inside an emphasis or link. Parsing the sliced source
 * alone would reinterpret unmatched delimiters as visible characters. */
export const strippedMarkdownSourceRange = (
  source: string,
  start: number,
  end: number,
): string => {
  const pieces: string[] = [];
  let previousEnd: number | undefined;
  for (const leaf of markdownTextLeaves(source)) {
    const first = leaf.offsets.findIndex((offset) => offset >= start);
    const last = leaf.offsets.findLastIndex((offset) => offset <= end);
    if (first === -1 || last <= first) {
      continue;
    }
    const pieceStart = leaf.offsets.at(first);
    const pieceEnd = leaf.offsets.at(last);
    if (pieceStart === undefined || pieceEnd === undefined) {
      continue;
    }
    if (
      previousEnd !== undefined &&
      /\n/u.test(source.slice(previousEnd, pieceStart))
    ) {
      pieces.push("\n");
    }
    pieces.push(leaf.text.slice(first, last));
    previousEnd = pieceEnd;
  }
  return pieces.join("");
};

const stampedLeaf = (node: Node, root: HTMLElement): HTMLElement | null => {
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  const leaf = element.closest("[data-src-start][data-src-end]");
  return leaf instanceof HTMLElement && root.contains(leaf) ? leaf : null;
};

const endpointSourceOffset = (
  node: Node,
  localOffset: number,
  root: HTMLElement,
): number | undefined => {
  const leaf = stampedLeaf(node, root);
  if (!leaf) {
    return undefined;
  }
  const prefix = root.ownerDocument.createRange();
  prefix.selectNodeContents(leaf);
  prefix.setEnd(node, localOffset);
  const renderedOffset = prefix.toString().length;
  const offsets = leaf.dataset.srcOffsets?.split(",").map(Number);
  const offset = offsets?.at(renderedOffset);
  return offset !== undefined && Number.isSafeInteger(offset)
    ? offset
    : undefined;
};

type MapMarkdownSelectionOptions = {
  range: Range;
  root: HTMLElement;
  source: string;
};

const splitsSurrogatePair = (text: string, offset: number) =>
  /[\uD800-\uDBFF]/u.test(text.charAt(offset - 1)) &&
  /[\uDC00-\uDFFF]/u.test(text.charAt(offset));

export const mapMarkdownSelection = ({
  range,
  root,
  source,
}: MapMarkdownSelectionOptions) => {
  const start = endpointSourceOffset(
    range.startContainer,
    range.startOffset,
    root,
  );
  const end = endpointSourceOffset(range.endContainer, range.endOffset, root);
  const selectedText = normalizeMarkdownSelectionText(range.toString());
  if (
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end > source.length ||
    start >= end ||
    splitsSurrogatePair(source, start) ||
    splitsSurrogatePair(source, end) ||
    !selectedText
  ) {
    return { status: "unsupported" } as const;
  }
  const stripped = normalizeMarkdownSelectionText(
    strippedMarkdownSourceRange(source, start, end),
  );
  if (stripped !== selectedText) {
    return { status: "unsupported" } as const;
  }
  return { status: "mapped", start, end, selectedText } as const;
};
