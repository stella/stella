/**
 * The verification graph as the browser draws it: the server's pages merged
 * into one model, narrowed by the filters, the neighbourhood of a focused
 * node, the layered layout of the canvas, and the chronology of the facts.
 * No React, no I/O: the canvas, the list form and the chronology all read
 * this one model, so they cannot disagree about what the graph holds.
 */

import { panic } from "better-result";

import type { ClaimState, VerificationGraphPage } from "@/features/avt/types";
import { isConflictState } from "@/features/avt/verdict";

export type GraphStatement = VerificationGraphPage["statements"][number];
export type GraphClaim = VerificationGraphPage["claims"][number];
export type GraphFact = VerificationGraphPage["facts"][number];
export type GraphSource = VerificationGraphPage["sources"][number];
export type GraphCitation = VerificationGraphPage["citations"][number];
export type GraphProvenance = VerificationGraphPage["provenance"][number];
export type GraphFactTier = GraphFact["tier"];

export type GraphModel = {
  statements: readonly GraphStatement[];
  claims: readonly GraphClaim[];
  facts: readonly GraphFact[];
  sources: readonly GraphSource[];
  citations: readonly GraphCitation[];
  provenance: readonly GraphProvenance[];
  /** The list holds more facts than the graph carries. */
  factOverflow: boolean;
};

const provenanceKey = (edge: GraphProvenance) =>
  `${edge.factId}|${edge.sourceId}|${JSON.stringify(edge.locator)}`;

/**
 * One model from every page read so far, in page order. Each page carries
 * the list's facts; a fact off the list arrives with the page whose claims
 * link it. A document continued across pages keeps its first place.
 */
export const mergeGraphPages = (
  pages: readonly VerificationGraphPage[],
): GraphModel => {
  const statements = new Map<string, GraphStatement>();
  const claims = new Map<string, GraphClaim>();
  const facts = new Map<string, GraphFact>();
  const sources = new Map<string, GraphSource>();
  const citations = new Map<string, GraphCitation>();
  const provenance = new Map<string, GraphProvenance>();
  for (const page of pages) {
    for (const statement of page.statements) {
      if (!statements.has(statement.id)) {
        statements.set(statement.id, statement);
      }
    }
    for (const claim of page.claims) {
      claims.set(claim.id, claim);
    }
    for (const fact of page.facts) {
      if (!facts.has(fact.id)) {
        facts.set(fact.id, fact);
      }
    }
    for (const source of page.sources) {
      if (!sources.has(source.id)) {
        sources.set(source.id, source);
      }
    }
    for (const citation of page.citations) {
      citations.set(`${citation.claimId}|${citation.factId}`, citation);
    }
    for (const edge of page.provenance) {
      provenance.set(provenanceKey(edge), edge);
    }
  }
  const statementOrder = new Map(
    [...statements.keys()].map((id, index) => [id, index]),
  );
  return {
    statements: [...statements.values()],
    // Claims of a continued document sort back under it.
    claims: [...claims.values()].toSorted(
      (a, b) =>
        (statementOrder.get(a.statementId) ?? 0) -
          (statementOrder.get(b.statementId) ?? 0) || a.position - b.position,
    ),
    // Facts on the list first, in list order, as the server sends them.
    facts: [...facts.values()].toSorted(
      (a, b) => Number(b.listed) - Number(a.listed),
    ),
    sources: [...sources.values()],
    citations: [...citations.values()],
    provenance: [...provenance.values()],
    factOverflow: pages.some((page) => page.factOverflow),
  };
};

/** Which claims the graph shows: all, the conflicts, or one verdict. */
export type VerdictFilter = "all" | "conflicts" | ClaimState;

/** Which facts the graph shows by footing. A document's record is the
 *  expected footing, so it is never a filter of its own. */
export type TierFilter = "any" | Exclude<GraphFactTier, "document">;

export type GraphFilters = {
  verdict: VerdictFilter;
  tier: TierFilter;
  /** Held facts are drawn muted; off, they and their links are hidden. */
  showHeld: boolean;
};

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  verdict: "all",
  tier: "any",
  showHeld: true,
};

export const isFiltered = (filters: GraphFilters): boolean =>
  filters.verdict !== DEFAULT_GRAPH_FILTERS.verdict ||
  filters.tier !== DEFAULT_GRAPH_FILTERS.tier ||
  filters.showHeld !== DEFAULT_GRAPH_FILTERS.showHeld;

const claimMatches = (claim: GraphClaim, verdict: VerdictFilter): boolean => {
  if (verdict === "all") {
    return true;
  }
  if (verdict === "conflicts") {
    return isConflictState(claim.state);
  }
  return claim.state === verdict;
};

/**
 * The part of the model the filters leave. A verdict narrows the claims and
 * keeps the facts they link; a footing narrows the facts and keeps the
 * claims that link them; a fact no shown claim links stays only while no
 * filter narrows the claims or facts. Documents and sources follow what is
 * left, so nothing is drawn without the thing it belongs to.
 */
export const filterGraph = (
  model: GraphModel,
  filters: GraphFilters,
): GraphModel => {
  const factPasses = (fact: GraphFact) =>
    (filters.showHeld || !fact.held) &&
    (filters.tier === "any" || fact.tier === filters.tier);
  const passingFacts = new Set(
    model.facts.filter(factPasses).map((fact) => fact.id),
  );
  const verdictClaims = new Set(
    model.claims
      .filter((claim) => claimMatches(claim, filters.verdict))
      .map((claim) => claim.id),
  );
  const linksPassing = new Set(
    model.citations
      .filter((edge) => passingFacts.has(edge.factId))
      .map((edge) => edge.claimId),
  );
  const claims = model.claims.filter(
    (claim) =>
      verdictClaims.has(claim.id) &&
      (filters.tier === "any" || linksPassing.has(claim.id)),
  );
  const claimIds = new Set(claims.map((claim) => claim.id));
  const citations = model.citations.filter(
    (edge) => claimIds.has(edge.claimId) && passingFacts.has(edge.factId),
  );
  const linkedFacts = new Set(citations.map((edge) => edge.factId));
  const narrowsClaims = filters.verdict !== "all";
  const facts = model.facts.filter(
    (fact) =>
      passingFacts.has(fact.id) && (!narrowsClaims || linkedFacts.has(fact.id)),
  );
  const factIds = new Set(facts.map((fact) => fact.id));
  const provenance = model.provenance.filter((edge) =>
    factIds.has(edge.factId),
  );
  const sourceIds = new Set(provenance.map((edge) => edge.sourceId));
  const narrowed = narrowsClaims || filters.tier !== "any";
  const statementIds = new Set(claims.map((claim) => claim.statementId));
  return {
    statements: model.statements.filter(
      (statement) => !narrowed || statementIds.has(statement.id),
    ),
    claims,
    facts,
    sources: model.sources.filter((source) => sourceIds.has(source.id)),
    citations,
    provenance,
    factOverflow: model.factOverflow,
  };
};

export type GraphNodeKind = "statement" | "claim" | "fact" | "source";
export type GraphNodeRef = { kind: GraphNodeKind; id: string };

export const nodeKey = ({ kind, id }: GraphNodeRef) => `${kind}:${id}`;

export type Neighbourhood = {
  nodes: ReadonlySet<string>;
  /** Edge keys: `claimId|factId` and `factId|sourceId`. */
  edges: ReadonlySet<string>;
};

export const citationKey = (edge: Pick<GraphCitation, "claimId" | "factId">) =>
  `${edge.claimId}|${edge.factId}`;
export const provenanceEdgeKey = (
  edge: Pick<GraphProvenance, "factId" | "sourceId">,
) => `${edge.factId}|${edge.sourceId}`;

/**
 * A focused node and everything one hop from it on either side: a claim's
 * document and facts, a fact's claims and sources, a document's claims, a
 * source's facts. Only the edges between the node and those neighbours
 * stay lit.
 */
export const neighbourhoodOf = (
  model: GraphModel,
  focus: GraphNodeRef,
): Neighbourhood => {
  const nodes = new Set([nodeKey(focus)]);
  const edges = new Set<string>();
  const add = (ref: GraphNodeRef) => nodes.add(nodeKey(ref));
  switch (focus.kind) {
    case "statement": {
      for (const claim of model.claims) {
        if (claim.statementId === focus.id) {
          add({ kind: "claim", id: claim.id });
        }
      }
      break;
    }
    case "claim": {
      const claim = model.claims.find((item) => item.id === focus.id);
      if (claim !== undefined) {
        add({ kind: "statement", id: claim.statementId });
      }
      for (const edge of model.citations) {
        if (edge.claimId === focus.id) {
          add({ kind: "fact", id: edge.factId });
          edges.add(citationKey(edge));
        }
      }
      break;
    }
    case "fact": {
      for (const edge of model.citations) {
        if (edge.factId === focus.id) {
          add({ kind: "claim", id: edge.claimId });
          edges.add(citationKey(edge));
        }
      }
      for (const edge of model.provenance) {
        if (edge.factId === focus.id) {
          add({ kind: "source", id: edge.sourceId });
          edges.add(provenanceEdgeKey(edge));
        }
      }
      break;
    }
    case "source": {
      for (const edge of model.provenance) {
        if (edge.sourceId === focus.id) {
          add({ kind: "fact", id: edge.factId });
          edges.add(provenanceEdgeKey(edge));
        }
      }
      break;
    }
    default: {
      focus.kind satisfies never;
      return panic(`Unhandled graph node: ${String(focus.kind)}`);
    }
  }
  return { nodes, edges };
};

/** Heights the canvas draws each kind of node at, and the gaps between. */
export const GRAPH_GEOMETRY = {
  claimHeight: 56,
  factHeight: 56,
  sourceHeight: 36,
  gap: 8,
  /** Between the claims of one document and the next. */
  groupGap: 24,
} as const;

export type NodeBox = { y: number; height: number };

export type GraphLayout = {
  /** Top and height of each node, by `nodeKey`. */
  boxes: ReadonlyMap<string, NodeBox>;
  /** The order each column draws in. */
  columns: {
    statements: readonly GraphStatement[];
    claims: readonly GraphClaim[];
    facts: readonly GraphFact[];
    sources: readonly GraphSource[];
  };
  height: number;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Stack a column's nodes in order, each as near the middle of what it links
 * to (`target`) as the nodes above it allow, so links run as flat as they
 * can without nodes overlapping. Nodes that link nothing follow, packed.
 */
const placeColumn = <Node extends { id: string }>(
  nodes: readonly Node[],
  target: (node: Node) => number | null,
  height: number,
): { order: Node[]; tops: Map<string, number>; bottom: number } => {
  const indexed = nodes.map((node, index) => ({
    node,
    index,
    centre: target(node),
  }));
  const linked = indexed
    .filter((entry) => entry.centre !== null)
    .toSorted((a, b) => (a.centre ?? 0) - (b.centre ?? 0) || a.index - b.index);
  const unlinked = indexed.filter((entry) => entry.centre === null);
  const tops = new Map<string, number>();
  let cursor = 0;
  for (const { node, centre } of linked) {
    const top = Math.max(cursor, (centre ?? 0) - height / 2);
    tops.set(node.id, top);
    cursor = top + height + GRAPH_GEOMETRY.gap;
  }
  for (const { node } of unlinked) {
    tops.set(node.id, cursor);
    cursor += height + GRAPH_GEOMETRY.gap;
  }
  return {
    order: [...linked, ...unlinked].map(({ node }) => node),
    tops,
    bottom: cursor,
  };
};

/**
 * The layered layout: documents, their claims, the facts, the sources, from
 * the reading start. Deterministic, so the same graph is the same picture:
 * claims keep their document's reading order, a document spans its claims,
 * facts sit by the claims that link them, sources by the first fact that cites them.
 */
export const layoutGraph = (model: GraphModel): GraphLayout => {
  const { claimHeight, factHeight, sourceHeight, gap, groupGap } =
    GRAPH_GEOMETRY;
  const boxes = new Map<string, NodeBox>();
  const claimCentre = new Map<string, number>();
  let cursor = 0;
  const statements: GraphStatement[] = [];
  for (const statement of model.statements) {
    const claims = model.claims.filter(
      (claim) => claim.statementId === statement.id,
    );
    if (statements.length > 0) {
      cursor += groupGap - gap;
    }
    statements.push(statement);
    const top = cursor;
    for (const claim of claims) {
      boxes.set(nodeKey({ kind: "claim", id: claim.id }), {
        y: cursor,
        height: claimHeight,
      });
      claimCentre.set(claim.id, cursor + claimHeight / 2);
      cursor += claimHeight + gap;
    }
    const height = Math.max(claimHeight, cursor - gap - top);
    boxes.set(nodeKey({ kind: "statement", id: statement.id }), {
      y: top,
      height,
    });
    cursor = top + height + gap;
  }
  const claimsBottom = cursor;

  const factLinks = new Map<string, number[]>();
  for (const edge of model.citations) {
    const centre = claimCentre.get(edge.claimId);
    if (centre !== undefined) {
      factLinks.set(edge.factId, [
        ...(factLinks.get(edge.factId) ?? []),
        centre,
      ]);
    }
  }
  const facts = placeColumn(
    model.facts,
    (fact) => mean(factLinks.get(fact.id) ?? []),
    factHeight,
  );
  const factCentre = new Map<string, number>();
  for (const fact of facts.order) {
    const top = facts.tops.get(fact.id) ?? 0;
    boxes.set(nodeKey({ kind: "fact", id: fact.id }), {
      y: top,
      height: factHeight,
    });
    factCentre.set(fact.id, top + factHeight / 2);
  }

  const sourceLinks = new Map<string, number[]>();
  for (const edge of model.provenance) {
    const centre = factCentre.get(edge.factId);
    if (centre !== undefined) {
      sourceLinks.set(edge.sourceId, [
        ...(sourceLinks.get(edge.sourceId) ?? []),
        centre,
      ]);
    }
  }
  const sources = placeColumn(
    model.sources,
    // A document many facts cite sits by the first of them, so the column
    // reads from the top rather than drifting to the middle of a long list.
    (source) => {
      const centres = sourceLinks.get(source.id) ?? [];
      return centres.length === 0 ? null : Math.min(...centres);
    },
    sourceHeight,
  );
  for (const source of sources.order) {
    boxes.set(nodeKey({ kind: "source", id: source.id }), {
      y: sources.tops.get(source.id) ?? 0,
      height: sourceHeight,
    });
  }

  return {
    boxes,
    columns: {
      statements,
      claims: model.claims,
      facts: facts.order,
      sources: sources.order,
    },
    height: Math.max(claimsBottom, facts.bottom, sources.bottom, 0),
  };
};

/** The facts a claim links, each with how it links it, in the model's
 *  fact order: what the list form draws as the claim's chips. */
export const claimLinks = (model: GraphModel, claimId: string) => {
  const factOrder = new Map(model.facts.map((fact, index) => [fact.id, index]));
  const factsById = new Map(model.facts.map((fact) => [fact.id, fact]));
  return model.citations
    .filter((edge) => edge.claimId === claimId)
    .flatMap((edge) => {
      const fact = factsById.get(edge.factId);
      return fact === undefined ? [] : [{ edge, fact }];
    })
    .toSorted(
      (a, b) =>
        (factOrder.get(a.fact.id) ?? 0) - (factOrder.get(b.fact.id) ?? 0),
    );
};

/** The facts no shown claim links. */
export const unlinkedFacts = (model: GraphModel) => {
  const linked = new Set(model.citations.map((edge) => edge.factId));
  return model.facts.filter((fact) => !linked.has(fact.id));
};

export type ChronologyRow = {
  fact: GraphFact;
  sources: readonly (GraphProvenance & { name: string })[];
  claims: readonly GraphClaim[];
};

export type ChronologyGroup =
  | { type: "dated"; rows: readonly ChronologyRow[] }
  | { type: "undated"; rows: readonly ChronologyRow[] };

const compareIsoDates = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** Coarser precision first on the same stored day: "2021" before "Jan 2021"
 *  before "1 Jan 2021", since a partial date is stored as its first day. */
const PRECISION_RANK = { year: 0, month: 1, day: 2 } as const;

/**
 * The list's facts in the order they happened, as precisely as each date is
 * known, with the facts nobody dated last. Ties keep the list's order. Each
 * row names where the fact comes from and the claims that link it.
 */
export const chronologyOf = (model: GraphModel): ChronologyGroup[] => {
  const listOrder = new Map(model.facts.map((fact, index) => [fact.id, index]));
  const sourceName = new Map(
    model.sources.map((source) => [source.id, source.name]),
  );
  const claimsById = new Map(model.claims.map((claim) => [claim.id, claim]));
  const rowOf = (fact: GraphFact): ChronologyRow => ({
    fact,
    sources: model.provenance
      .filter((edge) => edge.factId === fact.id)
      .map((edge) => ({ ...edge, name: sourceName.get(edge.sourceId) ?? "" })),
    claims: model.citations
      .filter((edge) => edge.factId === fact.id)
      .flatMap((edge) => {
        const claim = claimsById.get(edge.claimId);
        return claim === undefined ? [] : [claim];
      }),
  });
  const dated = model.facts
    .filter((fact) => fact.occurredOn !== null)
    .toSorted((a, b) => {
      // ISO dates order as text.
      const byDate = compareIsoDates(a.occurredOn ?? "", b.occurredOn ?? "");
      if (byDate !== 0) {
        return byDate;
      }
      const rank = (fact: GraphFact) =>
        fact.occurredOnPrecision === null
          ? PRECISION_RANK.day
          : PRECISION_RANK[fact.occurredOnPrecision];
      return (
        rank(a) - rank(b) ||
        (listOrder.get(a.id) ?? 0) - (listOrder.get(b.id) ?? 0)
      );
    });
  const undated = model.facts.filter((fact) => fact.occurredOn === null);
  return [
    ...(dated.length === 0
      ? []
      : [{ type: "dated" as const, rows: dated.map(rowOf) }]),
    ...(undated.length === 0
      ? []
      : [{ type: "undated" as const, rows: undated.map(rowOf) }]),
  ];
};
