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
              return panic("Markdown fence token has no enclosing code node");
            }
            fenceCounts.set(node, (fenceCounts.get(node) ?? 0) + 1);
          },
        },
      },
    ],
  });
  return {
    root,
    fencesClosed: Array.from(fenceCounts.values()).every(
      (count) => count === 2,
    ),
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
  delta: number;
};

// Preserve every node outside the edit and the containers crossing its
// boundary. Nodes wholly inside the selection may be rewritten freely.
const projectOutsideStructure = ({
  node,
  start,
  end,
  delta,
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
          projectOutsideStructure({ node: child, start, end, delta }),
        );
  // Text nodes can merge across the splice; compare their preserved prefix
  // and suffix via the server splice invariant rather than their AST shape.
  if (node.type === "text") {
    return [];
  }
  let position;
  if (nodeEnd <= start) {
    position = [nodeStart, nodeEnd];
  } else if (nodeStart >= end) {
    position = [nodeStart - delta, nodeEnd - delta];
  } else {
    position = [
      nodeStart < start ? nodeStart : start,
      nodeEnd > end ? nodeEnd - delta : end - delta,
    ];
  }
  // Keep every parser-owned semantic attribute (including task-list state,
  // code language and link titles). Leaf values are covered by the splice;
  // positions and children have their own projections.
  const semantics = { ...node };
  delete semantics.position;
  delete semantics.children;
  delete semantics.value;
  return [{ ...semantics, position, children }];
};

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
  const delta = replacement.length - (end - start);
  const parsedOriginal = parseMarkdown(source);
  const parsedCandidate = parseMarkdown(before + replacement + after);
  if (!parsedCandidate.fencesClosed) {
    return false;
  }
  const original = projectOutsideStructure({
    node: parsedOriginal.root,
    start,
    end,
    delta: 0,
  });
  const candidate = projectOutsideStructure({
    node: parsedCandidate.root,
    start,
    end: start + replacement.length,
    delta,
  });
  return JSON.stringify(original) === JSON.stringify(candidate);
};
