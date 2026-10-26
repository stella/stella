import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { DecisionReaderAdapters } from "@stll/decision-reader/reader-adapters";
import type { CitedProvisionTarget } from "@stll/decision-reader/reader-types";

import type { MarginItem } from "@/components/legal-reader/margin-notes";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { DecisionReaderProvider } =
  await import("@stll/decision-reader/reader-adapters");
const { IntlProvider } = await import("use-intl");
const { MarginNotes } = await import("@/components/legal-reader/margin-notes");
const messages = (await import("@/i18n/langs/en.json")).default;

class ResizeObserverProbe implements ResizeObserver {
  static instances = new Set<ResizeObserverProbe>();
  readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverProbe.instances.add(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    ResizeObserverProbe.instances.delete(this);
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  emit(target: Element) {
    if (this.observed.has(target)) {
      this.callback([], this);
    }
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = ResizeObserverProbe;

afterEach(() => {
  cleanup();
  ResizeObserverProbe.instances.clear();
});
afterAll(async () => {
  globalThis.ResizeObserver = originalResizeObserver;
  await unregisterDomEnvironment();
});

const renderInline = (items: MarginItem[]): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <MarginNotes items={items} placement="inline" />
    </IntlProvider>,
  );

const analysisNote: MarginItem = {
  accentVar: "--option-violet",
  depth: 0,
  id: "note-1",
  kind: "annotation",
  startAnchorId: "p-1",
  text: "What the model made of the paragraph.",
};

const ownComment: MarginItem = {
  author: { image: null, name: "Reader" },
  createdAt: "2026-09-01T10:00:00.000Z",
  id: "comment-1",
  kind: "comment",
  mine: true,
  onDelete: () => undefined,
  onToggleVisibility: () => undefined,
  startAnchorId: "p-1",
  text: "My own words.",
  updatedAt: "2026-09-01T10:00:00.000Z",
  visibility: "private",
};

describe("notes drawn in the text's own flow", () => {
  // The inline note is already at its anchor, so there is nothing to jump to.
  test("an analysis note is read, not operated", () => {
    expect(renderInline([analysisNote])).not.toContain("<button");
  });

  // The inline layout is what a touch screen gets, and there is no hover
  // there to reveal anything.
  test("a reader's own comment keeps its controls on screen", () => {
    const markup = renderInline([ownComment]);

    expect(markup).toContain(messages.common.delete);
    expect(markup).not.toContain("opacity-0");
  });

  // Every reader's optimistic comment carries a pending id until the server
  // stores it; there is nothing yet to change or delete it by.
  test("a reader's own comment not yet stored offers no controls", () => {
    const markup = renderInline([
      {
        ...ownComment,
        id: "pending:1:0",
        onEdit: () => undefined,
      },
    ]);

    expect(markup).toContain("My own words.");
    expect(markup).not.toContain("<button");
  });
});

const provision = {
  document: {
    country: "CZ",
    eli: "/eli/cz/sb/2012/89",
    id: "act-1",
    slug: "civil-code",
    versionValidFrom: "2014-01-01",
  },
  payload: {
    anchorId: "section-1",
    documentId: "act-1",
    eli: "/eli/cz/sb/2012/89",
    jurisdiction: "CZ",
    provisionLabel: "§ 1",
    statuteTitle: "Civil Code",
    versionCount: 1,
    versionValidFrom: "2014-01-01",
  },
  preview: {
    anchorId: "section-1",
    blocks: [{ anchorId: "sentence-1", id: "sentence-1", text: "Cited text." }],
    citedAnchorId: "sentence-1",
    documentId: "act-1",
    heading: null,
    headings: [],
    language: "en",
  },
} satisfies CitedProvisionTarget;

const readerAdapters = {
  messages: {
    "statutes.diffRemoved": "Removed",
    "statutes.diffInserted": "Inserted",
    "common.copyLink": "Copy link",
    "common.copied": "Copied",
    "common.back": "Back",
    "caseLaw.viewer.legalSentence": "Legal sentence",
    "caseLaw.viewer.abstract": "Abstract",
    "folio.comment": "Comment",
    "legalReader.annotations.highlight": "Highlight",
    "caseLaw.reader.headMatter": "Head matter",
    "caseLaw.notesFilter.ai": "AI",
    "common.court": "Court",
    "statutes.wordingVersionUnknown": "Wording version unknown",
    "statutes.openProvision": "Open provision",
    "statutes.provisionTextUnavailable": "Text not available",
    "statutes.showCitedPartOnly": "Show cited part only",
    "statutes.showFullProvision": "Show full provision",
    "aiDisclosure.caseLaw": "Generated by stella, not by the court.",
    sourceAttribution: (source, link) => <>{link(source)}</>,
    dissentByline: (names) => names.join(", "),
    provisionPartTextUnavailable: (label) => `${label} is unavailable`,
    provisionEffectiveFrom: (date) => `in force since ${date}`,
    formatValidityDate: (date) => date,
    provisionActText: ({ statuteTitle }) => statuteTitle,
    formatLabelList: (labels) => labels.join(", "),
  },
  copyPermalink: async () => true,
  loadProvisionPreview: async () => null,
  openProvision: () => undefined,
  renderBodyUnavailable: () => null,
  renderDecisionLink: ({ children }) => <span>{children}</span>,
  renderStatuteLink: (props) =>
    props.type === "statute" || props.type === "provision" ? (
      <span>{props.children}</span>
    ) : (
      <span>{props.citations.at(0)?.payload.provisionLabel}</span>
    ),
} satisfies DecisionReaderAdapters;

test("an expanding provision card pushes the following gutter note below its new bottom", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  let provisionHeight = 40;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const anchor = this.dataset["anchor"];
    const top = anchor === "p-2" ? 20 : 0;
    const width = this.classList.contains("inset-0") ? 300 : 0;
    return DOMRect.fromRect({ y: top, width });
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.parentElement?.dataset["marginNote"] === "provision"
        ? provisionHeight
        : 20;
    },
  });

  try {
    const scrollRef = React.createRef<HTMLDivElement>();
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const items: MarginItem[] = [
      {
        citations: [provision],
        id: "provision-1",
        kind: "provision",
        startAnchorId: "p-1",
      },
      { ...analysisNote, id: "note-2", startAnchorId: "p-2" },
    ];
    const mounted = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DecisionReaderProvider adapters={readerAdapters}>
            <div ref={scrollRef}>
              <p data-anchor="p-1" />
              <p data-anchor="p-2" />
              <MarginNotes
                items={items}
                placement="gutter"
                scrollContainerRef={scrollRef}
              />
            </div>
          </DecisionReaderProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );

    const following = await waitFor(() => {
      const element = mounted.container.querySelector<HTMLElement>(
        '[data-margin-note="annotation"] > *',
      );
      expect(element?.style.top).toBe("56px");
      if (element === null) {
        throw new Error("The following gutter note is not rendered");
      }
      return element;
    });
    const card = mounted.container.querySelector<HTMLElement>(
      '[data-slot="provision-card"]',
    );
    const wrapper = mounted.container.querySelector<HTMLElement>(
      '[data-margin-note="provision"] > div',
    );
    expect(card).not.toBeNull();
    expect(wrapper).not.toBeNull();

    provisionHeight = 100;
    fireEvent.click(card!);
    await act(async () => {
      for (const observer of ResizeObserverProbe.instances) {
        observer.emit(wrapper!);
      }
    });

    expect(following.style.top).toBe("116px");
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalHeight === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        originalHeight,
      );
    }
  }
});
