import { forceLayout } from "@tanstack/charts/network/force";
import { panic } from "better-result";

import type { CitationPage } from "./parse";

export const EXPANSION_LIMIT = 5;
type Citation = CitationPage["citations"][number];
export type GraphNode =
  | { type: "subject"; id: string }
  | {
      type: "resolved";
      id: string;
      decision: NonNullable<Citation["decision"]>;
    }
  | { type: "unresolved"; id: string; citationText: Citation["citationText"] };
export type GraphModel = {
  subjectId: string;
  direction: CitationPage["direction"];
  doctrine: CitationPage["doctrine"];
  polarity: CitationPage["polarity"];
  pages: readonly CitationPage[];
  expanded: readonly string[];
};

export const createGraph = (page: CitationPage): GraphModel => ({
  subjectId: page.decisionId,
  direction: page.direction,
  doctrine: page.doctrine,
  polarity: page.polarity,
  pages: [page],
  expanded: [],
});

export const canExpand = (model: GraphModel, decisionId: string) =>
  decisionId !== model.subjectId &&
  !model.expanded.includes(decisionId) &&
  model.expanded.length < EXPANSION_LIMIT;

export const mergePage = (model: GraphModel, page: CitationPage) => {
  if (page.direction !== model.direction) {
    return model;
  }
  const previous = model.pages.find(
    ({ decisionId }) => decisionId === page.decisionId,
  );
  if (previous === undefined && !canExpand(model, page.decisionId)) {
    return model;
  }
  const citations = new Map<string, Citation>();
  if (previous !== undefined) {
    for (const citation of previous.citations) {
      citations.set(citation.citationId, citation);
    }
  }
  for (const citation of page.citations) {
    citations.set(citation.citationId, citation);
  }
  const merged = { ...page, citations: [...citations.values()] };
  const pages =
    previous === undefined
      ? [...model.pages, merged]
      : model.pages.map((entry) =>
          entry.decisionId === page.decisionId ? merged : entry,
        );
  return {
    subjectId: model.subjectId,
    direction: model.direction,
    doctrine: model.doctrine,
    polarity: model.polarity,
    pages,
    expanded:
      previous === undefined
        ? [...model.expanded, page.decisionId]
        : model.expanded,
  };
};

export const graphElements = (model: GraphModel) => {
  const nodes = new Map<string, GraphNode>([
    [model.subjectId, { type: "subject", id: model.subjectId }],
  ]);
  const edges = new Map<
    string,
    Citation & {
      id: string;
      source: string;
      target: string;
      direction: CitationPage["direction"];
    }
  >();
  for (const page of model.pages) {
    for (const citation of page.citations) {
      const node: GraphNode =
        citation.decision === null
          ? {
              type: "unresolved",
              id: `unresolved:${citation.citationId}`,
              citationText:
                citation.textWithheldReason === null
                  ? citation.citationText
                  : null,
            }
          : {
              type: "resolved",
              id: citation.decision.decisionId,
              decision: citation.decision,
            };
      if (node.id !== model.subjectId) {
        nodes.set(node.id, node);
      }
      const source = page.direction === "cites" ? page.decisionId : node.id;
      const target = page.direction === "cites" ? node.id : page.decisionId;
      edges.set(citation.citationId, {
        ...citation,
        citationText:
          citation.textWithheldReason === null ? citation.citationText : null,
        passage: citation.textWithheldReason === null ? citation.passage : null,
        id: citation.citationId,
        source,
        target,
        direction: page.direction,
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
};

export const POLARITY_DASH = {
  negative: "2 2",
  neutral: "none",
  positive: "8 2",
  supportive: "12 3",
  mixed: "8 2 2 2",
  unclassified: "1 5",
} as const satisfies Record<Citation["polarity"], string>;

export const layoutGraph = (model: GraphModel) => {
  const { nodes, edges } = graphElements(model);
  const layout = forceLayout(nodes, edges, {
    nodeKey: "id",
    source: "source",
    target: "target",
    iterations: 120,
    forces: [
      { type: "link", distance: 140 },
      { type: "manyBody", strength: -500 },
      { type: "collide", radius: 55 },
      { type: "x", x: 0, strength: 0.03 },
      { type: "y", y: 0, strength: 0.03 },
    ],
  });
  const centre =
    layout.nodes.find(({ id }) => id === model.subjectId) ??
    panic("Citation graph has no subject");
  const spanX = Math.max(
    1,
    ...layout.nodes.map(({ x }) => Math.abs(x - centre.x)),
  );
  const spanY = Math.max(
    1,
    ...layout.nodes.map(({ y }) => Math.abs(y - centre.y)),
  );
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  // Keep the subject centred and every hit area inside the fixed viewport.
  return {
    nodes: nodes.map((node) => {
      const position =
        positions.get(node.id) ?? panic("Citation node has no position");
      return {
        ...node,
        x: 400 + ((position.x - centre.x) / spanX) * 300,
        y: 240 + ((position.y - centre.y) / spanY) * 170,
      };
    }),
    edges,
  };
};
