import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  chronologyOf,
  DEFAULT_GRAPH_FILTERS,
  filterGraph,
  GRAPH_GEOMETRY,
  layoutGraph,
  mergeGraphPages,
  neighbourhoodOf,
  nodeKey,
} from "@/features/avt/graph/graph-model.logic";
import type {
  GraphFilters,
  GraphModel,
} from "@/features/avt/graph/graph-model.logic";
import {
  GRAPH_TEXT,
  graphClaimId,
  graphFactId,
  graphPage,
  sourceId,
  statementId,
} from "@/features/avt/graph/graph.test-fixtures";

const model = (): GraphModel => mergeGraphPages([graphPage()]);

const filtersArbitrary: fc.Arbitrary<GraphFilters> = fc.record({
  verdict: fc.constantFrom(
    "all",
    "conflicts",
    "supported",
    "tension",
    "contradicted",
    "nocover",
    "recordconflict",
    "notverifiable",
  ),
  tier: fc.constantFrom("any", "document", "testimony", "unsourced"),
  showHeld: fc.boolean(),
});

describe("mergeGraphPages", () => {
  test("a document continued on the next page keeps its place and claims", () => {
    const page = graphPage();
    const first = {
      ...page,
      claims: page.claims.slice(0, 2),
      citations: page.citations.slice(0, 3),
      nextCursor: "next",
    };
    const second = {
      ...page,
      statements: [page.statements[0], page.statements[1]].filter(
        (statement) => statement !== undefined,
      ),
      claims: page.claims.slice(2),
      citations: page.citations.slice(3),
    };
    const merged = mergeGraphPages([first, second]);
    expect(merged).toEqual(mergeGraphPages([page]));
  });
});

describe("filterGraph", () => {
  test("nothing is drawn without what it belongs to", () => {
    assertProperty(
      "nothing is drawn without what it belongs to",
      fc.property(filtersArbitrary, (filters) => {
        const shown = filterGraph(model(), filters);
        const statements = new Set(shown.statements.map(({ id }) => id));
        const claims = new Set(shown.claims.map(({ id }) => id));
        const facts = new Set(shown.facts.map(({ id }) => id));
        const sources = new Set(shown.sources.map(({ id }) => id));
        for (const claim of shown.claims) {
          expect(statements.has(claim.statementId)).toBe(true);
        }
        for (const edge of shown.citations) {
          expect(claims.has(edge.claimId) && facts.has(edge.factId)).toBe(true);
        }
        for (const edge of shown.provenance) {
          expect(facts.has(edge.factId) && sources.has(edge.sourceId)).toBe(
            true,
          );
        }
        if (!filters.showHeld) {
          expect(shown.facts.some((fact) => fact.held)).toBe(false);
        }
        if (filters.tier !== "any") {
          expect(shown.facts.every((fact) => fact.tier === filters.tier)).toBe(
            true,
          );
        }
      }),
    );
  });

  test("conflicts keep the contradicted claim and the record conflict", () => {
    const shown = filterGraph(model(), {
      ...DEFAULT_GRAPH_FILTERS,
      verdict: "conflicts",
    });
    expect(shown.claims.map((claim) => claim.text)).toEqual([
      GRAPH_TEXT.payment,
      GRAPH_TEXT.meeting,
    ]);
    // Both records of the conflict stay, never one.
    expect(
      shown.citations.filter((edge) => edge.claimId === graphClaimId(2)),
    ).toHaveLength(2);
    // A fact no shown claim links goes.
    expect(shown.facts.map((fact) => fact.id)).not.toContain(graphFactId(1));
  });

  test("hiding held facts drops their links, not the claims", () => {
    const shown = filterGraph(model(), {
      ...DEFAULT_GRAPH_FILTERS,
      showHeld: false,
    });
    expect(shown.facts.map((fact) => fact.id)).not.toContain(graphFactId(5));
    expect(shown.claims.map((claim) => claim.id)).toContain(graphClaimId(4));
    expect(shown.citations.some((edge) => edge.factId === graphFactId(5))).toBe(
      false,
    );
  });
});

describe("neighbourhoodOf", () => {
  test("a claim lights its document and both records of its conflict", () => {
    const area = neighbourhoodOf(model(), {
      kind: "claim",
      id: graphClaimId(2),
    });
    expect([...area.nodes].toSorted()).toEqual(
      [
        nodeKey({ kind: "claim", id: graphClaimId(2) }),
        nodeKey({ kind: "statement", id: statementId(1) }),
        nodeKey({ kind: "fact", id: graphFactId(2) }),
        nodeKey({ kind: "fact", id: graphFactId(3) }),
      ].toSorted(),
    );
  });

  test("a fact lights its claims and sources, one hop each side", () => {
    const area = neighbourhoodOf(model(), {
      kind: "fact",
      id: graphFactId(2),
    });
    expect(
      area.nodes.has(nodeKey({ kind: "claim", id: graphClaimId(2) })),
    ).toBe(true);
    expect(area.nodes.has(nodeKey({ kind: "source", id: sourceId(2) }))).toBe(
      true,
    );
    // Two hops away: the claim's document is not lit.
    expect(
      area.nodes.has(nodeKey({ kind: "statement", id: statementId(1) })),
    ).toBe(false);
  });
});

describe("layoutGraph", () => {
  test("the same graph is the same picture, and no column overlaps itself", () => {
    assertProperty(
      "the same graph is the same picture, and no column overlaps itself",
      fc.property(filtersArbitrary, (filters) => {
        const shown = filterGraph(model(), filters);
        const layout = layoutGraph(shown);
        expect(layoutGraph(shown)).toEqual(layout);
        for (const prefix of ["claim:", "fact:", "source:"]) {
          const boxes = [...layout.boxes]
            .filter(([key]) => key.startsWith(prefix))
            .map(([, box]) => box)
            .toSorted((a, b) => a.y - b.y);
          for (const [index, box] of boxes.entries()) {
            const next = boxes[index + 1];
            if (next !== undefined) {
              expect(next.y).toBeGreaterThanOrEqual(
                box.y + box.height + GRAPH_GEOMETRY.gap - 0.001,
              );
            }
          }
        }
      }),
    );
  });

  test("a document spans its claims, in reading order", () => {
    const layout = layoutGraph(model());
    const first = layout.boxes.get(
      nodeKey({ kind: "statement", id: statementId(1) }),
    );
    const claims = [1, 2, 3].map((n) =>
      layout.boxes.get(nodeKey({ kind: "claim", id: graphClaimId(n) })),
    );
    expect(claims.map((box) => box?.y)).toEqual(
      claims.map((box) => box?.y).toSorted((a, b) => (a ?? 0) - (b ?? 0)),
    );
    expect(first?.y).toBe(claims[0]?.y);
    expect((first?.y ?? 0) + (first?.height ?? 0)).toBe(
      (claims[2]?.y ?? 0) + (claims[2]?.height ?? 0),
    );
  });
});

describe("chronologyOf", () => {
  test("facts run by date at their precision, the undated last", () => {
    const groups = chronologyOf(model());
    expect(groups.map((group) => group.type)).toEqual(["dated", "undated"]);
    expect(groups[0]?.rows.map((row) => row.fact.text)).toEqual([
      GRAPH_TEXT.calendar,
      GRAPH_TEXT.minutes,
      GRAPH_TEXT.ledger,
      GRAPH_TEXT.recalled,
    ]);
    expect(groups[1]?.rows.map((row) => row.fact.text)).toEqual([
      GRAPH_TEXT.heldNote,
      GRAPH_TEXT.undatedFact,
      GRAPH_TEXT.oldFact,
    ]);
  });

  test("a row names the claims that rest on its fact and where it comes from", () => {
    const rows = chronologyOf(model()).flatMap((group) => group.rows);
    const ledger = rows.find((row) => row.fact.id === graphFactId(2));
    expect(ledger?.claims.map((claim) => claim.id)).toEqual([graphClaimId(2)]);
    expect(ledger?.sources).toEqual([
      {
        factId: graphFactId(2),
        sourceId: sourceId(2),
        locator: { type: "pdf-page", pageNumber: 14 },
        quote: null,
        name: "Ledger export.pdf",
      },
    ]);
  });
});
