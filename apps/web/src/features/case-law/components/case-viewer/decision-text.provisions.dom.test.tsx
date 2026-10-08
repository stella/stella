import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { sleep } from "@stll/concurrency/sleep";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { DecisionProvisionAnchor } from "./use-decision-provision-anchors";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { DecisionText } = await import("./decision-text");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toSafeId } = await import("@/lib/safe-id");

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});

afterAll(async () => {
  await sleep(0);
  await GlobalRegistrator.unregister();
});

const FIRST_CITATION = "§ 31 odst. 4";
const SECOND_CITATION = "§ 7";
const THIRD_CITATION = "§ 90 odst. 5";
const FIRST_PARAGRAPH = `Ustanovení ${FIRST_CITATION} věty třetí zákona a ${SECOND_CITATION} se použijí společně.`;
const SECOND_PARAGRAPH = `Dále soud použil ${THIRD_CITATION} k rozhodnutí věci.`;
const HEADNOTE = "The court applies the cited provisions together.";
const WORDING_VERSION_LABEL = "Wording in force since Jan 1, 2026";

const paragraph = (id: string, text: string) => ({
  anchorId: `anchor-${id}`,
  id,
  inlines: [{ text, type: "text" as const }],
  plainText: text,
  type: "paragraph" as const,
});

const ast = {
  blocks: [
    paragraph("first", FIRST_PARAGRAPH),
    paragraph("second", SECOND_PARAGRAPH),
  ],
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} satisfies DocumentAst;

const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

const decision = {
  caseNumber: "1 As 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Test court",
  courtAbbreviation: null,
  courtTier: "other",
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  id: toSafeId<"caseLawDecision">("9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  judges: [],
  language: "cs",
  sourceAttributionUrl: null,
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: { text: HEADNOTE, type: TEXT_FIELD_TYPE.PRESENT },
    summary: absent,
  },
} satisfies ComponentProps<typeof DecisionText>["decision"];

type AnchorOptions = {
  blockId: string;
  citation: string;
  section: number;
  sentenceText: string;
  subsection: string | null;
};

const provisionAnchor = ({
  blockId,
  citation,
  section,
  sentenceText,
  subsection,
}: AnchorOptions): DecisionProvisionAnchor => {
  const start = sentenceText.indexOf(citation);
  const documentId = toSafeId<"legislationDocument">(
    "c7bbc901-27a1-4d00-b75a-111111111111",
  );
  const anchorId = `par-${String(section)}`;
  return {
    exactSpan: { blockId, end: start + citation.length, start },
    id: `${blockId}-${anchorId}`,
    reference: {
      letter: null,
      section,
      sectionSuffix: null,
      subsection,
      unit: "section",
    },
    sentenceText,
    spanStart: start,
    target: {
      document: {
        country: "cz",
        eli: "/eli/cz/sb/2026/1",
        id: documentId,
        slug: "test-act",
        versionValidFrom: "2026-01-01",
      },
      payload: {
        anchorId,
        documentId,
        eli: "/eli/cz/sb/2026/1",
        jurisdiction: "CZE",
        provisionLabel: `§ ${String(section)}`,
        statuteTitle: "Test Act",
        versionCount: 1,
        versionValidFrom: "2026-01-01",
      },
      preview: {
        anchorId,
        blocks: [
          {
            anchorId: `${anchorId}-body`,
            id: `${anchorId}-body`,
            text: `Wording for ${citation}.`,
          },
        ],
        citedAnchorId: null,
        documentId,
        heading: null,
        headings: [],
        language: "cs",
      },
    },
  };
};

const anchors = [
  provisionAnchor({
    blockId: "first",
    citation: SECOND_CITATION,
    section: 7,
    sentenceText: FIRST_PARAGRAPH,
    subsection: null,
  }),
  provisionAnchor({
    blockId: "second",
    citation: THIRD_CITATION,
    section: 90,
    sentenceText: SECOND_PARAGRAPH,
    subsection: "5",
  }),
  provisionAnchor({
    blockId: "first",
    citation: FIRST_CITATION,
    section: 31,
    sentenceText: FIRST_PARAGRAPH,
    subsection: "4",
  }),
];

const renderDecision = async (
  expandProvisions?: boolean,
  provisionAnchors = anchors,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => (
      <DecisionText
        surface="development"
        decision={decision}
        decisionId={decision.id}
        expandProvisions={expandProvisions}
        provisionAnchors={provisionAnchors}
      />
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </IntlProvider>,
  );
};

describe("provision wording below decision paragraphs", () => {
  test("keeps both paragraphs whole and groups labelled cards below each in citation order", async () => {
    const view = await renderDecision(true);
    const first = view.container.querySelector('p[data-anchor="anchor-first"]');
    const second = view.container.querySelector(
      'p[data-anchor="anchor-second"]',
    );
    // The existing paragraph permalink contributes a pilcrow before its text.
    expect(first?.textContent).toBe(`¶${FIRST_PARAGRAPH}`);
    expect(second?.textContent).toBe(`¶${SECOND_PARAGRAPH}`);
    expect(first?.querySelector('[data-slot="provision-card"]')).toBeNull();
    expect(second?.querySelector('[data-slot="provision-card"]')).toBeNull();

    const cards = [
      ...view.container.querySelectorAll('[data-slot="provision-card"]'),
    ];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.firstElementChild?.textContent)).toEqual([
      FIRST_CITATION,
      SECOND_CITATION,
      THIRD_CITATION,
    ]);
    expect(first?.nextElementSibling).toBe(cards.at(0));
    expect(cards.at(0)?.nextElementSibling).toBe(cards.at(1));
    expect(second?.nextElementSibling).toBe(cards.at(2));
    for (const [index, citation] of [
      FIRST_CITATION,
      SECOND_CITATION,
      THIRD_CITATION,
    ].entries()) {
      const card = cards.at(index);
      expect(card?.textContent).toContain(`Wording for ${citation}.`);
      expect(card?.textContent).toContain(WORDING_VERSION_LABEL);
      expect(card?.textContent).not.toContain(messages.statutes.currentWording);
    }
  });

  test("uses the headnote's inset surface for each expanded provision", async () => {
    const view = await renderDecision(true);
    const headnoteBox = view.getByText(HEADNOTE).closest(".bg-muted\\/30");
    expect(headnoteBox).not.toBeNull();
    const cards = view.container.querySelectorAll(
      '[data-slot="provision-card"]',
    );
    expect(cards).toHaveLength(3);
    for (const token of [
      "bg-muted/30",
      "border-border/50",
      "rounded-lg",
      "border",
      "px-5",
      "py-4",
    ]) {
      expect(headnoteBox?.classList.contains(token)).toBe(true);
      for (const card of cards) {
        expect(card.classList.contains(token)).toBe(true);
      }
    }
  });

  test("states when an expanded provision's wording date is unavailable", async () => {
    const unknownVersionAnchors = anchors.map((anchor) => ({
      ...anchor,
      target: {
        ...anchor.target,
        document: { ...anchor.target.document, versionValidFrom: null },
        payload: { ...anchor.target.payload, versionValidFrom: null },
      },
    }));
    const view = await renderDecision(true, unknownVersionAnchors);
    const cards = view.container.querySelectorAll(
      '[data-slot="provision-card"]',
    );
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.textContent).toContain("Wording version date unavailable");
      expect(card.textContent).not.toContain(messages.statutes.currentWording);
      expect(card.textContent).not.toContain(WORDING_VERSION_LABEL);
    }
  });

  test("defaults to collapsed wording and a plain citation click peeks without splitting the paragraph", async () => {
    const view = await renderDecision();
    expect(
      view.container.querySelector('[data-slot="provision-card"]'),
    ).toBeNull();
    expect(view.queryByText(`Wording for ${FIRST_CITATION}.`)).toBeNull();
    const link = view.getByRole("link", { name: FIRST_CITATION });
    expect(link.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(link);
    await waitFor(() => {
      expect(link.getAttribute("aria-expanded")).toBe("true");
      expect(
        within(view.baseElement).getByText(`Wording for ${FIRST_CITATION}.`),
      ).toBeDefined();
    });
    expect(
      within(view.baseElement).getByText(WORDING_VERSION_LABEL),
    ).toBeDefined();
    expect(
      within(view.baseElement).queryByText(messages.statutes.currentWording),
    ).toBeNull();
    expect(
      view.container.querySelector('p[data-anchor="anchor-first"]')
        ?.textContent,
    ).toBe(`¶${FIRST_PARAGRAPH}`);
    expect(
      view.container.querySelector('[data-slot="provision-card"]'),
    ).toBeNull();
  });
});
