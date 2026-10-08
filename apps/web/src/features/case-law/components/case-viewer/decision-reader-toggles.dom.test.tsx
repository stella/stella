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

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

// Happy DOM has ranges but no CSS Custom Highlight API; the find paints
// through it, so a registry stands in for the browser's.
class ReaderHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}
const highlights = new Map<string, ReaderHighlight>();
const readerCss = CSS;
Object.defineProperty(readerCss, "highlights", {
  configurable: true,
  value: highlights,
});
Object.defineProperty(globalThis, "CSS", {
  configurable: true,
  value: readerCss,
});
Object.defineProperty(globalThis, "Highlight", {
  configurable: true,
  value: ReaderHighlight,
});

/**
 * Happy DOM lays nothing out, so the reader's scrollers get a deterministic
 * layout: every element inside one is a row of fixed height, in document
 * order, and the browser's scrolling primitives move the scroller over those
 * rows. Inserting content above a passage therefore pushes it down exactly as
 * a browser without scroll anchoring would, and any scroll the reader issues
 * moves what is on screen.
 */
const ROW_PX = 24;
const VIEW_PX = 480;
const scrollers = new Set<HTMLElement>();
const scrollTops = new WeakMap<HTMLElement, number>();

const scrollerOf = (element: Element): HTMLElement | undefined =>
  [...scrollers].find(
    (scroller) => scroller !== element && scroller.contains(element),
  );
const contentTop = (scroller: HTMLElement, element: Element): number =>
  [...scroller.querySelectorAll("*")].indexOf(element) * ROW_PX;
const setScrollTop = (scroller: HTMLElement, value: number) => {
  scrollTops.set(scroller, Math.max(0, value));
};

const registerScroller = (scroller: HTMLElement) => {
  if (scrollers.has(scroller)) {
    return;
  }
  scrollers.add(scroller);
  scrollTops.set(scroller, 0);
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTops.get(scroller) ?? 0,
    set: (value: number) => setScrollTop(scroller, value),
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: VIEW_PX,
  });
  scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    const top = typeof options === "number" ? y : options?.top;
    if (top !== undefined) {
      setScrollTop(scroller, top);
    }
  };
};

const rect = (top: number, height: number) =>
  DOMRect.fromRect({ height, width: 600, x: 0, y: top });

Element.prototype.getBoundingClientRect = function getBoundingClientRect(
  this: Element,
) {
  if (this instanceof HTMLElement && scrollers.has(this)) {
    return rect(0, VIEW_PX);
  }
  const scroller = scrollerOf(this);
  if (scroller === undefined) {
    return rect(0, 0);
  }
  return rect(contentTop(scroller, this) - scroller.scrollTop, ROW_PX);
};
Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
  const scroller = scrollerOf(this);
  if (scroller !== undefined) {
    setScrollTop(scroller, contentTop(scroller, this) - VIEW_PX / 2);
  }
};

const { useRef } = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { DecisionText } = await import("./decision-text");
const { InspectorFindBar, useInspectorFind } =
  await import("@/components/inspector/inspector-find");
const { ReaderProvisionModeToggle } =
  await import("@/components/legal-reader/reader-provision-mode-toggle");
const { useReaderProvisionMode } =
  await import("@/hooks/use-reader-provision-mode");
const { browserStorage } = await import("@/lib/account/browser-storage");
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
  scrollers.clear();
  highlights.clear();
  browserStorage("local")?.clear();
});

afterAll(async () => {
  await sleep(0);
  await GlobalRegistrator.unregister();
});

/** Only the opening paragraph carries it, so the find's match sits at the top. */
const FIND_QUERY = "úvodem";
const ABOVE_CITATION = "§ 7";
const MID_CITATION = "§ 31 odst. 4";
const ABOVE_PARAGRAPH = `Podle ${ABOVE_CITATION} zákona soud postupoval.`;
const MID_PARAGRAPH = `Rozhodující je ${MID_CITATION} zákona pro tuto věc.`;
const HEADNOTE = "Soud použije citovaná ustanovení společně.";

const paragraph = (id: string, text: string, role?: "counsel") => ({
  anchorId: `anchor-${id}`,
  id,
  inlines: [{ text, type: "text" as const }],
  plainText: text,
  role,
  type: "paragraph" as const,
});

const filler = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, offset) =>
    paragraph(
      `filler-${String(from + offset)}`,
      `Soud dále posuzoval okolnost číslo ${String(from + offset)}.`,
    ),
  );

const ast = {
  blocks: [
    paragraph("intro", "Úvodem soud shrnuje průběh řízení."),
    paragraph("above", ABOVE_PARAGRAPH),
    ...filler(1, 8),
    paragraph("mid", MID_PARAGRAPH),
    ...filler(9, 14),
    paragraph("counsel", "Za stěžovatele jednal advokát.", "counsel"),
    ...filler(15, 18),
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

const provisionAnchor = ({
  blockId,
  citation,
  section,
  sentenceText,
}: {
  blockId: string;
  citation: string;
  section: number;
  sentenceText: string;
}): DecisionProvisionAnchor => {
  const start = sentenceText.indexOf(citation);
  const documentId = toSafeId<"legislationDocument">(
    "c7bbc901-27a1-4d00-b75a-111111111111",
  );
  const anchorId = `par_${String(section)}`;
  return {
    exactSpan: { blockId, end: start + citation.length, start },
    id: `${blockId}-${anchorId}`,
    reference: {
      letter: null,
      section,
      sectionSuffix: null,
      subsection: null,
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
        // Several lines of wording, so a card is taller than one row.
        blocks: ["first", "second", "third"].map((line) => ({
          anchorId: `${anchorId}-${line}`,
          id: `${anchorId}-${line}`,
          text: `Wording ${line} of ${citation}.`,
        })),
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
    blockId: "above",
    citation: ABOVE_CITATION,
    section: 7,
    sentenceText: ABOVE_PARAGRAPH,
  }),
  provisionAnchor({
    blockId: "mid",
    citation: MID_CITATION,
    section: 31,
    sentenceText: MID_PARAGRAPH,
  }),
];

/**
 * One reader as the page and the inspector compose it: a toolbar outside the
 * scroller, the find bar opened with a query (as from a search result), and
 * the decision text inside the scroller.
 */
const Reader = ({ name }: { name: string }) => {
  const panelRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const provisions = useReaderProvisionMode(scrollRef);
  const find = useInspectorFind({
    contentRef,
    enabled: true,
    highlightKey: name,
    initialQuery: FIND_QUERY,
    panelRef,
  });
  return (
    <section aria-label={name} ref={panelRef}>
      <div data-testid="toolbar">
        <ReaderProvisionModeToggle mode={provisions} size="pane" />
      </div>
      <InspectorFindBar find={find} />
      <div
        data-testid="scroller"
        ref={(node) => {
          scrollRef.current = node;
          if (node !== null) {
            registerScroller(node);
          }
        }}
      >
        <div ref={contentRef}>
          <DecisionText
            surface="development"
            decision={decision}
            decisionId={decision.id}
            expandProvisions={provisions.expandProvisions}
            isHydrated
            provisionAnchors={anchors}
          />
        </div>
      </div>
    </section>
  );
};

const READERS: readonly string[] = ["page", "beside"];

const renderReaders = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => (
      <>
        {READERS.map((name) => (
          <Reader key={name} name={name} />
        ))}
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </IntlProvider>,
  );
  appRoot = view.baseElement;
  // The find has landed on its match before the reader scrolls away from it.
  await waitFor(() => {
    for (const name of READERS) {
      expect(highlights.get(`stella-inspector-find-active-${name}`)?.size).toBe(
        1,
      );
    }
  });
  return view;
};

/** The rendered app's body; the readers and their portals live under it. */
let appRoot: HTMLElement | null = null;

const readerParts = (name: string) => {
  const section = appRoot?.querySelector<HTMLElement>(
    `section[aria-label="${name}"]`,
  );
  const scroller = section?.querySelector<HTMLElement>(
    '[data-testid="scroller"]',
  );
  const citation = [
    ...(scroller?.querySelectorAll<HTMLElement>("a") ?? []),
  ].find((link) => link.textContent === MID_CITATION);
  if (!section || !scroller || !citation) {
    panic(`Reader ${name} did not render its citation`);
  }
  return { citation, scroller, section };
};

/** Where an element sits on screen, in the layout above. */
const offsetOf = (element: Element) => element.getBoundingClientRect().top;

/** Every control in the reader that opens or closes something. */
const TOGGLE_SELECTOR = "[aria-expanded], [aria-pressed], summary";

type ToggleKind = "disclosure" | "peek" | "pressed";

const toggleKind = (toggle: HTMLElement): ToggleKind => {
  if (toggle.tagName === "SUMMARY") {
    return "disclosure";
  }
  return toggle.hasAttribute("aria-pressed") ? "pressed" : "peek";
};

const toggleName = (toggle: HTMLElement, index: number) =>
  `${toggleKind(toggle)} ${String(index)}: ${
    toggle.getAttribute("aria-label") ?? toggle.textContent ?? ""
  }`;

/** Opens or closes, the way a reader's click does. */
const activate = async (toggle: HTMLElement) => {
  await act(async () => {
    toggle.focus();
    if (toggle.tagName === "SUMMARY") {
      const details = toggle.parentElement;
      if (!(details instanceof HTMLDetailsElement)) {
        panic("A summary outside its details");
      }
      const wasOpen = details.open;
      fireEvent.click(toggle);
      // Happy DOM does not run the summary's activation behaviour.
      if (details.open === wasOpen) {
        details.open = !wasOpen;
        details.dispatchEvent(new Event("toggle"));
      }
    } else {
      fireEvent.click(toggle);
    }
    await sleep(0);
  });
};

/** A peek closes on Escape; everything else closes the way it opened. */
const deactivate = async (toggle: HTMLElement) => {
  if (toggleKind(toggle) !== "peek") {
    await activate(toggle);
    return;
  }
  await act(async () => {
    fireEvent.keyDown(toggle, { key: "Escape" });
    await sleep(0);
  });
};

const POSITION_TOLERANCE_PX = 2;

type Watched = {
  citation: HTMLElement;
  element: Element;
  offset: number;
  scroller: HTMLElement;
};

/**
 * What must hold still. The control that was pressed stays where it was when
 * it sits in the text; a toolbar control has no place in the text, so the
 * passage being read (the mid citation, scrolled to the top of the view)
 * stays instead. Every reader, the one beside included, keeps its passage.
 */
const watch = (toggle: HTMLElement): Watched[] =>
  READERS.map((name) => {
    const { citation, scroller } = readerParts(name);
    const element = scroller.contains(toggle) ? toggle : citation;
    return { citation, element, offset: offsetOf(element), scroller };
  });

const expectStill = (watched: Watched[], toggle: HTMLElement, step: string) => {
  for (const { citation, element, offset, scroller } of watched) {
    // The same nodes: nothing the reader was looking at was remounted.
    expect(citation.isConnected, `${step}: citation remounted`).toBe(true);
    expect(element.isConnected, `${step}: watched element remounted`).toBe(
      true,
    );
    expect(
      Math.abs(offsetOf(element) - offset),
      `${step}: moved from ${String(offset)} to ${String(offsetOf(element))} (scrollTop ${String(scroller.scrollTop)})`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
  }
  if (toggle.isConnected && toggleKind(toggle) !== "peek") {
    expect(
      toggle.ownerDocument.activeElement,
      `${step}: focus left the toggle`,
    ).toBe(toggle);
  }
};

/** Scrolls each reader so what it watches sits in the middle of its text. */
const scrollToMiddle = (toggle: HTMLElement) => {
  for (const name of READERS) {
    const { citation, scroller } = readerParts(name);
    if (scroller.contains(toggle)) {
      scroller.scrollTop = contentTop(scroller, toggle) - VIEW_PX / 3;
      continue;
    }
    // The paragraph being read is the first one on screen.
    const block = citation.closest("[data-anchor]");
    if (block === null) {
      panic("The citation sits outside any block");
    }
    scroller.scrollTop = contentTop(scroller, block);
  }
};

const pageToggles = () => [
  ...readerParts("page").section.querySelectorAll<HTMLElement>(TOGGLE_SELECTOR),
];

describe("in-reader toggles keep the reader's place", () => {
  test("the layout moves a passage when content is inserted above it", async () => {
    // Guards the fixture: without this, a position assertion could pass
    // because nothing in the layout ever moves.
    await renderReaders();
    const { citation, scroller } = readerParts("page");
    const block = citation.closest("[data-anchor]");
    if (block === null) {
      panic("The citation sits outside any block");
    }
    scroller.scrollTop = contentTop(scroller, block);
    const before = offsetOf(citation);
    block.before(block.ownerDocument.createElement("div"));
    expect(offsetOf(citation)).toBe(before + ROW_PX);
  });

  test("the reader renders every kind of toggle the assertions cover", async () => {
    await renderReaders();
    const kinds = new Set(pageToggles().map(toggleKind));
    expect([...kinds].toSorted()).toEqual(["disclosure", "peek", "pressed"]);
    const pressed = pageToggles().filter(
      (toggle) => toggleKind(toggle) === "pressed",
    );
    expect(pressed.map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      messages.caseLaw.reader.expandProvisions,
    ]);
  });

  test("expanding and collapsing every toggle leaves the passage, the pressed control and focus where they were", async () => {
    await renderReaders();
    const names = pageToggles().map(toggleName);
    expect(names.length).toBeGreaterThanOrEqual(5);
    await act(async () => {
      cleanup();
    });
    scrollers.clear();
    highlights.clear();

    // A fresh reader per toggle, so one toggle's state cannot hide another's
    // jump.
    for (const [index, name] of names.entries()) {
      await renderReaders();
      const toggle = pageToggles().at(index);
      if (toggle === undefined || toggleName(toggle, index) !== name) {
        panic(`Toggle ${name} was not rendered again`);
      }
      scrollToMiddle(toggle);
      let watched = watch(toggle);
      await activate(toggle);
      expectStill(watched, toggle, `${name} open`);

      watched = watch(toggle);
      await deactivate(toggle);
      expectStill(watched, toggle, `${name} close`);

      await act(async () => {
        cleanup();
      });
      scrollers.clear();
      highlights.clear();
      browserStorage("local")?.clear();
    }
  });

  test("expanding provisions inserts cards above the passage without moving it", async () => {
    await renderReaders();
    const toggle = pageToggles().find(
      (candidate) => toggleKind(candidate) === "pressed",
    );
    if (toggle === undefined) {
      panic("The provision toggle was not rendered");
    }
    scrollToMiddle(toggle);
    const { citation, scroller } = readerParts("page");
    const block = citation.closest("[data-anchor]");
    if (block === null) {
      panic("The citation sits outside any block");
    }
    const topBefore = contentTop(scroller, block);
    const watched = watch(toggle);
    await activate(toggle);
    // The cards did land above the passage, so holding it still took a
    // correction rather than happening by accident.
    expect(
      scroller.querySelectorAll('[data-slot="provision-card"]').length,
    ).toBe(2);
    expect(contentTop(scroller, block)).toBeGreaterThan(topBefore);
    expectStill(watched, toggle, "expand");
  });
});
