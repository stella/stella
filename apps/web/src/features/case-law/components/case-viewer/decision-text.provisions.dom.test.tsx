import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
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

// Cards whose wording the decision's list did not carry read it themselves;
// each test states what that read answers.
const originalFetch = globalThis.fetch;
const previewRequests: string[] = [];
let previewResponse = (): Response =>
  Response.json({ message: "Unexpected read" }, { status: 500 });
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    previewRequests.push(input instanceof Request ? input.url : String(input));
    return previewResponse();
  },
  { preconnect: () => undefined },
);

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { DecisionText } = await import("./decision-text");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { createProvisionViewTab } =
  await import("@/features/statutes/provision-inspector.logic");
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
  previewRequests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await sleep(0);
  await GlobalRegistrator.unregister();
});

const FIRST_CITATION = "§ 31 odst. 4";
const SECOND_CITATION = "§ 7";
const THIRD_CITATION = "§ 90 odst. 5";
const FIRST_PARAGRAPH = `Ustanovení ${FIRST_CITATION} věty třetí zákona a ${SECOND_CITATION} se použijí společně.`;
const SECOND_PARAGRAPH = `Dále soud použil ${THIRD_CITATION} k rozhodnutí věci.`;
const HEADNOTE = "The court applies the cited provisions together.";
const WORDING_VERSION_LABEL = "in force since Jan 1, 2026";

const paragraph = (id: string, text: string) => ({
  anchorId: `anchor-${id}`,
  id,
  inlines: [{ text, type: "text" as const }],
  plainText: text,
  type: "paragraph" as const,
});

const PART_ONE = "§ 226 odst. 1";
const PART_TWO = "§ 226 odst. 2";
const REPEAT_PARAGRAPH = `Soud vyšel z ${PART_ONE}, k němuž se pojí ${PART_TWO}, a ${PART_ONE} použil znovu.`;
const VERSIONS_PARAGRAPH = `Soud porovnal ${SECOND_CITATION} dřívější s ${SECOND_CITATION} nynějším.`;

const ast = {
  blocks: [
    paragraph("first", FIRST_PARAGRAPH),
    paragraph("second", SECOND_PARAGRAPH),
    paragraph("repeat", REPEAT_PARAGRAPH),
    paragraph("versions", VERSIONS_PARAGRAPH),
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
        provisionLabel: citation,
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

const cardLabel = (card: Element) =>
  card.querySelector('[data-slot="provision-card-label"]')?.textContent;

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
    expect(cards.map(cardLabel)).toEqual([
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

describe("compact provision cards", () => {
  const firstCard = (view: Awaited<ReturnType<typeof renderDecision>>) =>
    view.container.querySelector('[data-slot="provision-card"]');

  const withTarget = (
    patch: (
      target: DecisionProvisionAnchor["target"],
    ) => DecisionProvisionAnchor["target"],
  ) => anchors.map((anchor) => ({ ...anchor, target: patch(anchor.target) }));

  test("names, dates and opens each provision in one header row", async () => {
    const view = await renderDecision(true);
    const cards = [
      ...view.container.querySelectorAll<HTMLElement>(
        '[data-slot="provision-card"]',
      ),
    ];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const headers = card.querySelectorAll(
        '[data-slot="provision-card-header"]',
      );
      expect(headers).toHaveLength(1);
      const header = headers.item(0);
      expect(header.textContent).toContain(WORDING_VERSION_LABEL);
      const open = within(card).getByRole("button", {
        name: messages.statutes.openProvision,
      });
      expect(header.contains(open)).toBe(true);
      // Icon-only: the name comes from the label, not from visible text.
      expect(open.textContent).toBe("");
    }
  });

  test("shows where a provision sits only where its label does not say so", async () => {
    const placed = withTarget((target) => ({
      ...target,
      preview:
        target.preview === null
          ? null
          : {
              ...target.preview,
              headings: [
                { anchorId: "odst", level: 1, text: "odst." },
                { anchorId: "cast-1", level: 2, text: "Část první" },
              ],
            },
    }));
    const view = await renderDecision(true, placed);
    const cards = [
      ...view.container.querySelectorAll('[data-slot="provision-card"]'),
    ];
    expect(cards.map(cardLabel)).toEqual([
      FIRST_CITATION,
      SECOND_CITATION,
      THIRD_CITATION,
    ]);
    // "§ 31 odst. 4" and "§ 90 odst. 5" already spell "odst." out; "§ 7"
    // does not, so only its card carries that place.
    expect(cards.map((card) => card.textContent.includes("odst. ›"))).toEqual([
      false,
      true,
      false,
    ]);
    for (const card of cards) {
      expect(card.textContent).toContain("Část první");
    }
  });

  test("says the text is not available when the applied version does not carry it", async () => {
    const empty = withTarget((target) => ({
      ...target,
      preview:
        target.preview === null ? null : { ...target.preview, blocks: [] },
    }));
    const view = await renderDecision(true, empty);
    const cards = view.container.querySelectorAll(
      '[data-slot="provision-card"]',
    );
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.textContent).toContain(
        messages.statutes.provisionTextUnavailable,
      );
      expect(card.textContent).not.toContain("Wording for");
    }
  });

  test("says the text is not available when its own read finds no provision", async () => {
    previewResponse = () =>
      Response.json({ message: "Provision not found" }, { status: 404 });
    const unread = withTarget((target) => ({ ...target, preview: null }));
    const view = await renderDecision(true, unread);
    expect(
      firstCard(view)?.querySelector('[data-slot="provision-card-pending"]'),
    ).not.toBeNull();
    await waitFor(() => {
      for (const card of view.container.querySelectorAll(
        '[data-slot="provision-card"]',
      )) {
        expect(card.textContent).toContain(
          messages.statutes.provisionTextUnavailable,
        );
      }
    });
    expect(previewRequests.length).toBeGreaterThan(0);
    expect(previewRequests.every((url) => url.includes("/preview"))).toBe(true);
  });

  test("says the text is not available when its own read fails", async () => {
    previewResponse = () =>
      Response.json({ message: "Server error" }, { status: 500 });
    const unread = withTarget((target) => ({ ...target, preview: null }));
    const view = await renderDecision(true, unread);
    await waitFor(() => {
      expect(firstCard(view)?.textContent).toContain(
        messages.statutes.provisionTextUnavailable,
      );
    });
    expect(
      firstCard(view)?.querySelector('[data-slot="provision-card-pending"]'),
    ).toBeNull();
  });
});

const ACT_DOCUMENT_ID = "c7bbc901-27a1-4d00-b75a-111111111111";
const EARLIER_DOCUMENT_ID = "c7bbc901-27a1-4d00-b75a-000000000000";

type CitationOptions = {
  blockId: string;
  citation: string;
  documentId?: string | undefined;
  /** Where in the sentence to start looking, for a repeated citation. */
  from?: number | undefined;
  part: string | null;
  section: number;
  sentenceText: string;
  versionValidFrom?: string | undefined;
};

/** A citation of a provision, or of one numbered part of it. */
const citationAnchor = ({
  blockId,
  citation,
  documentId = ACT_DOCUMENT_ID,
  from = 0,
  part,
  section,
  sentenceText,
  versionValidFrom = "2026-01-01",
}: CitationOptions): DecisionProvisionAnchor => {
  const start = sentenceText.indexOf(citation, from);
  const anchorId = `par_${String(section)}`;
  const citedAnchorId = part === null ? anchorId : `${anchorId}-odst_${part}`;
  const id = toSafeId<"legislationDocument">(documentId);
  return {
    exactSpan: { blockId, end: start + citation.length, start },
    id: `${blockId}-${citedAnchorId}-${String(start)}`,
    reference: {
      letter: null,
      section,
      sectionSuffix: null,
      subsection: part,
      unit: "section",
    },
    sentenceText,
    spanStart: start,
    target: {
      document: {
        country: "cz",
        eli: "/eli/cz/sb/2026/1",
        id,
        slug: "test-act",
        versionValidFrom,
      },
      payload: {
        anchorId,
        documentId: id,
        eli: "/eli/cz/sb/2026/1",
        highlightAnchorId: citedAnchorId,
        jurisdiction: "CZE",
        provisionLabel: citation,
        statuteTitle: "Test Act",
        versionCount: 2,
        versionValidFrom,
      },
      preview: {
        anchorId,
        blocks: [
          {
            anchorId: citedAnchorId,
            id: `${documentId}:${citedAnchorId}`,
            text: `Wording of ${citedAnchorId} in force since ${versionValidFrom}.`,
          },
        ],
        citedAnchorId: part === null ? null : citedAnchorId,
        documentId: id,
        heading: null,
        headings: [],
        language: "cs",
      },
    },
  };
};

const repeatCitation = (citation: string, part: string, from = 0) =>
  citationAnchor({
    blockId: "repeat",
    citation,
    from,
    part,
    section: 226,
    sentenceText: REPEAT_PARAGRAPH,
  });

const cardsIn = (
  view: Awaited<ReturnType<typeof renderDecision>>,
  anchorId: string,
) => {
  const cards: HTMLElement[] = [];
  let sibling = view.container.querySelector(
    `p[data-anchor="${anchorId}"]`,
  )?.nextElementSibling;
  while (
    sibling instanceof HTMLElement &&
    sibling.dataset.slot === "provision-card"
  ) {
    cards.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return cards;
};

describe("one card per cited provision in a paragraph", () => {
  test("a paragraph that cites one part of a provision twice gets one card", async () => {
    const view = await renderDecision(true, [
      repeatCitation(PART_ONE, "1"),
      repeatCitation(PART_ONE, "1", REPEAT_PARAGRAPH.lastIndexOf(PART_ONE)),
    ]);
    // Both mentions stay links; only the card is shared.
    expect(view.getAllByRole("link", { name: PART_ONE })).toHaveLength(2);
    const cards = cardsIn(view, "anchor-repeat");
    expect(cards).toHaveLength(1);
    expect(cards.map(cardLabel)).toEqual([PART_ONE]);
    expect(
      cards.at(0)?.querySelectorAll('[data-slot="provision-card-wording"] > *'),
    ).toHaveLength(1);
  });

  test("citations of two parts of one provision share a card that marks each part", async () => {
    const view = await renderDecision(true, [
      repeatCitation(PART_ONE, "1"),
      repeatCitation(PART_TWO, "2"),
      repeatCitation(PART_ONE, "1", REPEAT_PARAGRAPH.lastIndexOf(PART_ONE)),
    ]);
    const cards = cardsIn(view, "anchor-repeat");
    expect(cards).toHaveLength(1);
    const card = cards.at(0);
    expect(cardLabel(card ?? panic("No card"))).toBe(
      `${PART_ONE}, ${PART_TWO}`,
    );
    const marked = [...(card?.querySelectorAll("[data-cited]") ?? [])];
    expect(marked.map((block) => block.textContent)).toEqual([
      "Wording of par_226-odst_1 in force since 2026-01-01.",
      "Wording of par_226-odst_2 in force since 2026-01-01.",
    ]);
  });

  test("the same provision applied in two consolidations keeps a card for each", async () => {
    const versions = [
      citationAnchor({
        blockId: "versions",
        citation: SECOND_CITATION,
        documentId: EARLIER_DOCUMENT_ID,
        part: null,
        section: 7,
        sentenceText: VERSIONS_PARAGRAPH,
        versionValidFrom: "2020-01-01",
      }),
      citationAnchor({
        blockId: "versions",
        citation: SECOND_CITATION,
        from: VERSIONS_PARAGRAPH.lastIndexOf(SECOND_CITATION),
        part: null,
        section: 7,
        sentenceText: VERSIONS_PARAGRAPH,
      }),
    ];
    const view = await renderDecision(true, versions);
    const cards = cardsIn(view, "anchor-versions");
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("in force since Jan 1, 2020"),
      expect.stringContaining("in force since Jan 1, 2026"),
    ]);
  });
});

describe("the provision card header", () => {
  const headerParts = (header: Element) =>
    [...header.querySelectorAll<HTMLElement>(":scope > *")].map((part) =>
      part.matches("button")
        ? "button"
        : (part.dataset.slot ?? part.tagName.toLowerCase()),
    );

  const openPeek = async (
    view: Awaited<ReturnType<typeof renderDecision>>,
    citation: string,
  ) => {
    const link = view.getByRole("link", { name: citation });
    fireEvent.click(link);
    return await waitFor(
      () =>
        view.baseElement.querySelector<HTMLElement>(
          '[data-slot="preview-card-content"]',
        ) ?? panic("The hover card did not open"),
    );
  };

  test("the hover card and the inline card draw the same header", async () => {
    const view = await renderDecision(true);
    const inline =
      view.container.querySelector('[data-slot="provision-card-header"]') ??
      panic("The inline card has no header");
    const peek = await openPeek(view, FIRST_CITATION);
    const peeked =
      peek.querySelector('[data-slot="provision-card-header"]') ??
      panic("The hover card has no header");
    expect(
      peek.querySelectorAll('[data-slot="provision-card-header"]'),
    ).toHaveLength(1);
    expect(peeked.className).toBe(inline.className);
    expect(headerParts(peeked)).toEqual(headerParts(inline));
    expect(peeked.textContent).toBe(inline.textContent);
  });

  // Which part gives way at which width is measured in a browser
  // (e2e/ui-playground/provision-header.geometry.spec.ts); this pins the
  // structure that measurement relies on, and runs on every pull request.
  test("keeps the open button outside the part of the row that gives way", async () => {
    const view = await renderDecision();
    const peek = await openPeek(view, FIRST_CITATION);
    const header =
      peek.querySelector('[data-slot="provision-card-header"]') ??
      panic("The hover card has no header");
    expect(headerParts(header)).toEqual(["provision-card-summary", "button"]);
    const summary =
      header.querySelector('[data-slot="provision-card-summary"]') ??
      panic("The header has no summary");
    expect(headerParts(summary)).toEqual([
      "provision-card-label",
      "span",
      "provision-card-act",
      "span",
      "provision-card-date",
    ]);
    const classesOf = (slot: string) =>
      header.querySelector(`[data-slot="${slot}"]`)?.classList ??
      panic(`No ${slot}`);
    // One line that clips rather than wraps, beside a button it never clips.
    expect(
      classesOf("provision-card-summary").contains("whitespace-nowrap"),
    ).toBe(true);
    expect(
      classesOf("provision-card-summary").contains("overflow-hidden"),
    ).toBe(true);
    expect(header.classList.contains("overflow-hidden")).toBe(false);
    expect(header.classList.contains("flex-wrap")).toBe(false);
    // The act takes only the room left over, so it gives way first; the
    // label shrinks after it; the date never shrinks, only clips last.
    for (const token of [
      "flex-1",
      "basis-0",
      "max-w-max",
      "min-w-0",
      "truncate",
    ]) {
      expect(classesOf("provision-card-act").contains(token)).toBe(true);
    }
    for (const token of ["min-w-0", "truncate"]) {
      expect(classesOf("provision-card-label").contains(token)).toBe(true);
    }
    expect(classesOf("provision-card-date").contains("shrink-0")).toBe(true);
    const label =
      header.querySelector('[data-slot="provision-card-label"]') ??
      panic("No label");
    expect(label.textContent).toBe(FIRST_CITATION);
    expect(label.getAttribute("title")).toBe(FIRST_CITATION);
    expect(
      header.querySelector('[data-slot="provision-card-act"]')?.textContent,
    ).toBe("1/2026 Sb., Test Act");
    expect(
      header.querySelector('[data-slot="provision-card-date"]')?.textContent,
    ).toBe(WORDING_VERSION_LABEL);
  });

  test("drops the hierarchy line when it would not fit on one line", async () => {
    // Happy DOM lays nothing out: a line is as wide as its text, at 8px a
    // character, in a card 320px wide.
    const own = {
      clientWidth: Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "clientWidth",
      ),
      scrollWidth: Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollWidth",
      ),
    };
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent.length * 8;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 320,
    });
    try {
      const SHORT = "Část první";
      const LONG =
        "Hlava druhá o řízení před soudem prvního stupně a o jeho přípravě";
      const placed = anchors.map((anchor, index) => ({
        ...anchor,
        target: {
          ...anchor.target,
          preview:
            anchor.target.preview === null
              ? null
              : {
                  ...anchor.target.preview,
                  headings: [
                    {
                      anchorId: "place",
                      level: 1,
                      text: index === 0 ? LONG : SHORT,
                    },
                  ],
                },
        },
      }));
      const view = await renderDecision(true, placed);
      const trails = [
        ...view.container.querySelectorAll<HTMLElement>(
          '[data-slot="provision-card-trail"]',
        ),
      ];
      expect(
        trails.map((trail) => [
          trail.textContent,
          Object.hasOwn(trail.dataset, "clipped"),
        ]),
      ).toEqual([
        [SHORT, false],
        [LONG, true],
        [SHORT, false],
      ]);
    } finally {
      for (const [name, descriptor] of Object.entries(own)) {
        Reflect.deleteProperty(HTMLElement.prototype, name);
        if (descriptor !== undefined) {
          Object.defineProperty(HTMLElement.prototype, name, descriptor);
        }
      }
    }
  });

  test("the icon button opens the provision", async () => {
    const view = await renderDecision();
    const peek = await openPeek(view, FIRST_CITATION);
    const open = within(peek).getByRole("button", {
      name: messages.statutes.openProvision,
    });
    expect(open.textContent).toBe("");
    fireEvent.click(open);
    const target =
      anchors.find(
        (anchor) => anchor.target.payload.provisionLabel === FIRST_CITATION,
      )?.target ?? panic("No anchor for the first citation");
    expect(
      useInspectorTabsStore
        .getState()
        .tabs.some(
          (tab) => tab.id === createProvisionViewTab(target.payload).id,
        ),
    ).toBe(true);
  });
});
