import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";

import { GRAPH_TEST_CITATION_TREATMENTS } from "./citation-treatments.test-support";
import {
  canExpand,
  createGraph,
  EXPANSION_LIMIT,
  graphElements,
  layoutGraph,
  mergePage,
} from "./model";
import type { CitationPage } from "./parse";

const citationPage = ({
  decisionId = "synthetic-subject",
  direction = "cites",
  citations = [],
}: {
  decisionId?: string;
  direction?: CitationPage["direction"];
  citations?: CitationPage["citations"];
} = {}) =>
  ({
    doctrineAvailability: "unavailable",
    decisionId,
    direction,
    nextCursor: null,
    citations,
  }) satisfies CitationPage;

const citation = ({
  citationId,
  polarity = "unclassified",
  decisionId = "synthetic-cited-decision",
  decision = true,
  citationText = `Synthetic citation ${citationId}`,
  textWithheldReason = null,
  passage = null,
}: {
  citationId: string;
  polarity?: CitationPage["citations"][number]["polarity"];
  decisionId?: string;
  decision?: boolean;
  citationText?: string | null;
  textWithheldReason?: CitationPage["citations"][number]["textWithheldReason"];
  passage?: CitationPage["citations"][number]["passage"];
}): CitationPage["citations"][number] => ({
  citationId,
  citationText,
  textWithheldReason,
  polarity,
  doctrine: null,
  decision: decision
    ? {
        url: `https://stll.app/case-law/${decisionId}`,
        caseNumber: `Synthetic ${decisionId}`,
        citationAuthority: 1,
        court: "Synthetic Court",
        decisionDate: null,
        decisionId,
        decisionType: null,
        resourceName: `case-law/${decisionId}`,
      }
    : null,
  passage,
});

describe("citation graph model", () => {
  test("preserves the applied filters", () => {
    const page = {
      ...citationPage(),
      doctrine: "distinguishes",
      polarity: "supportive",
    } satisfies CitationPage;

    expect(createGraph(page)).toMatchObject({
      doctrine: "distinguishes",
      polarity: "supportive",
    });
  });

  test("preserves resolved and unresolved citations and every polarity", () => {
    const citations = GRAPH_TEST_CITATION_TREATMENTS.map((polarity, index) =>
      citation({
        citationId: `synthetic-citation-${index}`,
        polarity,
        decision: index !== GRAPH_TEST_CITATION_TREATMENTS.length - 1,
        decisionId: `synthetic-decision-${index}`,
      }),
    );
    const graph = graphElements(createGraph(citationPage({ citations })));

    expect(graph.edges.map(({ polarity }) => polarity)).toEqual([
      ...GRAPH_TEST_CITATION_TREATMENTS,
    ]);
    expect(graph.edges).toHaveLength(GRAPH_TEST_CITATION_TREATMENTS.length);
    expect(graph.nodes.filter(({ type }) => type === "resolved")).toHaveLength(
      GRAPH_TEST_CITATION_TREATMENTS.length - 1,
    );
    const unresolved =
      citations.at(-1) ?? panic("Missing unresolved citation fixture");
    expect(graph.nodes.filter(({ type }) => type === "unresolved")).toEqual([
      {
        type: "unresolved",
        id: `unresolved:${unresolved.citationId}`,
        citationText: unresolved.citationText,
      },
    ]);
  });

  test("withheld text and passage never reach graph nodes or edges", () => {
    const item = citation({
      citationId: "synthetic-withheld-citation",
      textWithheldReason: DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE,
      citationText: "Synthetic text that must stay hidden",
      passage: {
        anchorId: "synthetic-withheld-anchor",
        text: "Synthetic passage that must stay hidden",
        truncated: false,
        mention: "sole",
      },
    });
    const graph = graphElements(
      createGraph(citationPage({ citations: [item] })),
    );

    expect(graph.edges).toMatchObject([
      {
        citationText: null,
        passage: null,
        textWithheldReason: DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE,
      },
    ]);
  });

  test.each([
    ["cites", "synthetic-subject", "synthetic-cited-decision"],
    ["cited_by", "synthetic-cited-decision", "synthetic-subject"],
  ] as const)(
    "maps %s citations to source and target",
    (direction, source, target) => {
      const graph = graphElements(
        createGraph(
          citationPage({
            direction,
            citations: [citation({ citationId: "synthetic-edge" })],
          }),
        ),
      );

      expect(graph.edges).toMatchObject([{ source, target, direction }]);
    },
  );

  test("merges pages by citation id while preserving distinct edges to one decision", () => {
    const first = createGraph(
      citationPage({
        citations: [citation({ citationId: "synthetic-subject-to-target" })],
      }),
    );
    const firstExpandedPage = citationPage({
      decisionId: "synthetic-cited-decision",
      citations: [
        citation({ citationId: "synthetic-duplicate", polarity: "positive" }),
        citation({
          citationId: "synthetic-same-target-a",
          decisionId: "synthetic-shared-target",
        }),
      ],
    });
    const initialMerge = mergePage(first, firstExpandedPage);
    const merged = mergePage(
      initialMerge,
      citationPage({
        decisionId: "synthetic-cited-decision",
        citations: [
          citation({
            citationId: "synthetic-duplicate",
            polarity: "negative",
            decision: false,
          }),
          citation({
            citationId: "synthetic-same-target-b",
            decisionId: "synthetic-shared-target",
          }),
        ],
      }),
    );
    const graph = graphElements(merged);

    expect(merged.pages).toHaveLength(2);
    expect(
      merged.pages.at(1)?.citations.map(({ citationId }) => citationId),
    ).toEqual([
      "synthetic-duplicate",
      "synthetic-same-target-a",
      "synthetic-same-target-b",
    ]);
    expect(merged.pages.at(1)?.citations.at(0)?.polarity).toBe("negative");
    expect(graph.edges.map(({ id }) => id)).toEqual([
      "synthetic-subject-to-target",
      "synthetic-duplicate",
      "synthetic-same-target-a",
      "synthetic-same-target-b",
    ]);
    expect(
      graph.nodes.filter(({ id }) => id === "synthetic-shared-target"),
    ).toHaveLength(1);
  });

  test("does not merge a page from the opposite direction", () => {
    const model = createGraph(citationPage());
    const incompatible = citationPage({
      decisionId: "synthetic-other-subject",
      direction: "cited_by",
    });

    expect(mergePage(model, incompatible)).toBe(model);
  });

  test("caps expanded decisions and refuses a sixth expansion", () => {
    let model = createGraph(citationPage());
    for (let index = 0; index < EXPANSION_LIMIT; index += 1) {
      const decisionId = `synthetic-expansion-${index}`;
      expect(canExpand(model, decisionId)).toBe(true);
      model = mergePage(model, citationPage({ decisionId }));
    }
    expect(model.expanded).toHaveLength(EXPANSION_LIMIT);
    expect(canExpand(model, "synthetic-sixth-expansion")).toBe(false);
    expect(
      mergePage(
        model,
        citationPage({ decisionId: "synthetic-sixth-expansion" }),
      ),
    ).toBe(model);
  });

  test("lays out synchronously with a centred subject inside fixed bounds without mutating pages", () => {
    const model = createGraph(
      citationPage({
        citations: [
          citation({ citationId: "synthetic-layout-edge-a" }),
          citation({
            citationId: "synthetic-layout-edge-b",
            decisionId: "synthetic-layout-decision-b",
            polarity: "supportive",
          }),
        ],
      }),
    );
    const before = structuredClone(model);
    const layout = layoutGraph(model);

    expect(layout).not.toBeInstanceOf(Promise);
    expect(layout.nodes.find(({ id }) => id === model.subjectId)).toMatchObject(
      {
        x: 400,
        y: 240,
      },
    );
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(100);
      expect(node.x).toBeLessThanOrEqual(700);
      expect(node.y).toBeGreaterThanOrEqual(70);
      expect(node.y).toBeLessThanOrEqual(410);
    }
    expect(model).toEqual(before);
  });
});
