import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const parseMarkdown = (source: string) =>
  fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
type MarkdownNode = {
  type: string;
  position?: ReturnType<typeof fromMarkdown>["position"];
  children?: MarkdownNode[];
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  url?: string;
  align?: (string | null)[];
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
  return [
    {
      type: node.type,
      position,
      ...("depth" in node ? { depth: node.depth } : {}),
      ...("ordered" in node
        ? { ordered: node.ordered, start: node.start }
        : {}),
      ...("url" in node ? { url: node.url } : {}),
      ...("align" in node ? { align: node.align } : {}),
      children,
    },
  ];
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
  for (const delimiter of ["**", "__", "~~", "`", "*"]) {
    if (
      (before.endsWith(delimiter) && replacement.startsWith(delimiter)) ||
      (after.startsWith(delimiter) && replacement.endsWith(delimiter))
    ) {
      return false;
    }
  }
  const delta = replacement.length - (end - start);
  const original = projectOutsideStructure({
    node: parseMarkdown(source),
    start,
    end,
    delta: 0,
  });
  const candidate = projectOutsideStructure({
    node: parseMarkdown(before + replacement + after),
    start,
    end: start + replacement.length,
    delta,
  });
  return JSON.stringify(original) === JSON.stringify(candidate);
};
