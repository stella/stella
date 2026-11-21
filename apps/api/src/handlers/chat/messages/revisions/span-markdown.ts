import { panic } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const parseMarkdown = (source: string) => {
  const fenceCounts = new Map<MarkdownNode, number>();
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [
      gfmFromMarkdown(),
      {
        enter: {
          codeFencedFence() {
            // These events come from the CommonMark tokenizer, so literal
            // backticks in code, prose and URLs never count as fence closures.
            const node = this.stack.findLast(
              (candidate) => candidate.type === "code",
            );
            if (!node) {
              panic("Markdown fence token has no enclosing code node");
            }
            fenceCounts.set(node, (fenceCounts.get(node) ?? 0) + 1);
          },
        },
      },
    ],
  });
  return {
    root,
    unclosedFences: Array.from(fenceCounts.entries())
      .filter(([, count]) => count !== 2)
      .map(([node]) => node),
  };
};
type MarkdownNode = {
  type: string;
  position?: ReturnType<typeof fromMarkdown>["position"];
  children?: MarkdownNode[];
  value?: string;
};

type StructureProjectionOptions = {
  node: MarkdownNode;
  start: number;
  end: number;
};

// Preserve every node outside the edit and the containers crossing its
// boundary. Nodes wholly inside the selection may be rewritten freely.
const projectOutsideStructure = ({
  node,
  start,
  end,
}: StructureProjectionOptions): unknown[] => {
  const nodeStart = node.position?.start.offset;
  const nodeEnd = node.position?.end.offset;
  if (nodeStart === undefined || nodeEnd === undefined) {
    return [];
  }
  if (nodeStart >= start && nodeEnd <= end) {
    return [];
  }
  const children =
    node.children === undefined
      ? []
      : node.children.flatMap((child) =>
          projectOutsideStructure({ node: child, start, end }),
        );
  // Text nodes can merge across the splice; compare their preserved prefix
  // and suffix via the server splice invariant rather than their AST shape.
  if (node.type === "text") {
    return [];
  }
  // Collapse each tree's edited interval to the same point. This also maps
  // nodes touching a zero-width insertion or deletion without guessing which
  // side their endpoint belonged to before the splice.
  const position = [
    Math.min(nodeStart, start) + Math.max(0, nodeStart - end),
    Math.min(nodeEnd, start) + Math.max(0, nodeEnd - end),
  ];
  // Keep every parser-owned semantic attribute (including task-list state,
  // code language and link titles). Leaf values are covered by the splice;
  // positions and children have their own projections.
  const semantics = { ...node };
  delete semantics.position;
  delete semantics.children;
  delete semantics.value;
  return [{ ...semantics, position, children }];
};

const isLiteralProse = (root: ReturnType<typeof fromMarkdown>) =>
  root.children.length === 1 &&
  root.children.every(
    (node) =>
      node.type === "paragraph" &&
      node.children.every((child) => child.type === "text"),
  );

export const preservesMarkdownOutsideSpan = ({
  source,
  start,
  end,
  replacement,
}: {
  source: string;
  start: number;
  end: number;
  replacement: string;
}) => {
  const before = source.slice(0, start);
  const after = source.slice(end);
  const parsedOriginal = parseMarkdown(source);
  const parsedCandidate = parseMarkdown(before + replacement + after);
  // Literal paragraphs have no structural descendants. Their parser-owned
  // offsets can move as leading whitespace changes; the splice preserves
  // every character outside the edit regardless of those offsets.
  if (
    isLiteralProse(parsedOriginal.root) &&
    isLiteralProse(parsedCandidate.root)
  ) {
    return true;
  }

  const originalUnclosedFences = new Set(
    parsedOriginal.unclosedFences.flatMap((node) => {
      const projection = projectOutsideStructure({ node, start, end });
      return projection.length === 0 ? [] : [JSON.stringify(projection)];
    }),
  );
  // An existing unclosed fence may remain outside the edit. A new fence, or
  // one wholly rewritten inside the selection, must have a closing token.
  if (
    parsedCandidate.unclosedFences.some((node) => {
      const projection = projectOutsideStructure({
        node,
        start,
        end: start + replacement.length,
      });
      return (
        projection.length === 0 ||
        !originalUnclosedFences.has(JSON.stringify(projection))
      );
    })
  ) {
    return false;
  }
  const original = projectOutsideStructure({
    node: parsedOriginal.root,
    start,
    end,
  });
  const candidate = projectOutsideStructure({
    node: parsedCandidate.root,
    start,
    end: start + replacement.length,
  });
  return JSON.stringify(original) === JSON.stringify(candidate);
};
