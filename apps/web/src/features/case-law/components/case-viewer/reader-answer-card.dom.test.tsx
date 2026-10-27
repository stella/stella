import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import type {
  ReaderAnswer,
  ReaderAnswerCitation,
} from "@stll/api-contract/reader-answers";
import type { Block } from "@stll/legal-ast/document-ast";

import type { MarginItem } from "@/components/legal-reader/margin-notes";
import type { AnchoredNote } from "@/components/legal-reader/margin-notes.logic";
import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { cleanup, render, fireEvent, act, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { ReaderAnswerCard } = await import("./reader-answer-card");
const { resolveReaderAnswerCitation } =
  await import("./reader-answer-citation.logic");
const messages = (await import("@/i18n/langs/en.json")).default;
const arabicMessages = (await import("@/i18n/langs/ar.json")).default;
const observers: IntersectionObserverCallback[] = [];
let initialVisibility: "manual" | "visible" = "manual";
const originalObserver = globalThis.IntersectionObserver;
class VisibilityObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(callback);
  }
  observe(target: Element) {
    if (initialVisibility === "manual") {
      return;
    }
    queueMicrotask(() => {
      const bounds = target.getBoundingClientRect();
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: bounds,
            intersectionRect: bounds,
            rootBounds: null,
          },
        ],
        this,
      );
    });
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = VisibilityObserver;
afterEach(() => {
  cleanup();
  observers.length = 0;
  initialVisibility = "manual";
});
afterAll(async () => {
  globalThis.IntersectionObserver = originalObserver;
  await unregisterDomEnvironment();
});
const answer = {
  id: toSafeId<"legalReaderAnswer">("00000000-0000-4000-8000-000000000001"),
  decisionId: toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000002",
  ),
  authorId: toSafeId<"user">("00000000-0000-4000-8000-000000000003"),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: {
    spans: [
      {
        paragraphId: "p-2",
        quote: "Selected words",
        startOffset: 0,
        endOffset: 14,
      },
    ],
  },
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">(
        "00000000-0000-4000-8000-000000000004",
      ),
      role: "assistant",
      content: "An explanation.",
      citations: [
        {
          decisionId: toSafeId<"caseLawDecision">(
            "00000000-0000-4000-8000-000000000002",
          ),
          paragraphId: "p-5",
        },
        {
          decisionId: toSafeId<"caseLawDecision">(
            "00000000-0000-4000-8000-000000000005",
          ),
          paragraphId: "p-6",
        },
      ],
      model: "model",
      usage: null,
      status: "complete",
      errorCode: null,
      invalidCitationCount: 0,
      createdAt: "2026-10-10",
      updatedAt: "2026-10-10",
    },
  ],
  createdAt: "2026-10-10",
  updatedAt: "2026-10-10",
} satisfies ReaderAnswer;
const openBlocks = [
  {
    id: "five",
    anchorId: "p-5",
    type: "paragraph",
    number: 5,
    inlines: [],
    plainText: "The applicant was not heard before the order was made.",
  },
] satisfies Block[];
const citedDecision = {
  decisionId: "00000000-0000-4000-8000-000000000005",
  court: "Synthetic Supreme Court",
  courtShortCode: "SYN",
  caseNumber: "SYN 12/2026",
  decisionDate: "2026-01-12",
  readerUrl: "/law/cze/cases/synthetic-supreme-court/synthetic-decision",
  originalUrl: null,
} satisfies DecisionCitationMetadata;
const citedBlocks = [
  {
    id: "six",
    anchorId: "p-6",
    type: "paragraph",
    number: 6,
    inlines: [],
    plainText: "A hearing is required before an order of that kind.",
  },
] satisfies Block[];
const citationTarget = (citation: ReaderAnswerCitation) =>
  resolveReaderAnswerCitation({
    citation,
    decisionId: answer.decisionId,
    blocks: openBlocks,
    formatNumber: String,
    readCitedDecision: () => ({
      type: "loaded",
      decision: citedDecision,
      blocks: citedBlocks,
    }),
  });
const mount = (
  overrides: Partial<Parameters<typeof ReaderAnswerCard>[0]> = {},
  locale = "en",
) => {
  const handlers = {
    onFollowUp: mock((_question: string) => {}),
    onRegenerate: mock(() => undefined),
    onDelete: mock(() => undefined),
    onVisibility: mock((_visibility: ReaderAnswer["visibility"]) => undefined),
    onCitation: mock((_citation: ReaderAnswerCitation) => undefined),
    onOpen: mock(() => undefined),
  };
  const props = {
    answer,
    generationMode: "enabled" as const,
    ...handlers,
    active: false,
    openRevision: 0,
    citationTarget,
    language: "en",
    busy: false,
    ...overrides,
  };
  const tree = (updated: Parameters<typeof ReaderAnswerCard>[0] = props) => (
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? arabicMessages : messages}
      timeZone="UTC"
    >
      <FormattingProvider locale={locale} timeZone="UTC">
        <WebReaderPresentationProvider>
          <ReaderAnswerCard {...updated} />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>
  );
  return { ...render(tree()), handlers, tree, props };
};

test("citations preserve both decision and paragraph identity and each action calls its owner", async () => {
  const { container, findByRole, getByRole, handlers } = mount();
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-citation-kind]")].map(
      (chip) => chip.dataset["citationKind"],
    ),
  ).toEqual(["paragraph", "decision"]);
  fireEvent.click(getByRole("button", { name: "Paragraph 5" }));
  const decisionChip = getByRole("link", {
    name: "Synthetic Supreme Court, SYN 12/2026, Jan 12, 2026, paragraph 6",
  });
  expect(decisionChip.getAttribute("href")).toBe(
    `${citedDecision.readerUrl}#p-6`,
  );
  fireEvent.focus(decisionChip);
  fireEvent.click(
    await findByRole("button", { name: messages.common.openInSidePanel }),
  );
  const message = answer.messages.at(0);
  if (message === undefined) {
    throw new Error("Expected fixture assistant message");
  }
  expect(handlers.onCitation.mock.calls).toEqual(
    message.citations.map(
      (citation) => [citation] satisfies [ReaderAnswerCitation],
    ),
  );
  fireEvent.click(getByRole("button", { name: "Regenerate answer" }));
  fireEvent.click(getByRole("button", { name: "Delete" }));
  fireEvent.click(
    getByRole("button", {
      name: messages.readerAnswers.share,
    }),
  );
  expect(handlers.onRegenerate).toHaveBeenCalledTimes(1);
  expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  expect(handlers.onVisibility).toHaveBeenCalledWith("shared");
});

test("compact follow-up sends trimmed text once and clears the composer", () => {
  const { getByRole, handlers } = mount();
  const composer = getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(composer, { target: { value: "  Why?  " } });
  fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
  expect(handlers.onFollowUp).toHaveBeenCalledWith("Why?");
  expect(composer.getAttribute("value") ?? composer.textContent).toBe("");
  fireEvent.click(getByRole("button", { name: "Send follow-up" }));
  expect(handlers.onFollowUp).toHaveBeenCalledTimes(1);
});

test("IME confirmation does not send a follow-up until composition ends", () => {
  const { getByRole, handlers } = mount();
  const composer = getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(composer, { target: { value: "为什么？" } });
  fireEvent.compositionStart(composer);
  fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
  expect(handlers.onFollowUp).toHaveBeenCalledTimes(0);
  fireEvent.compositionEnd(composer);
  fireEvent.keyDown(composer, { key: "Enter", isComposing: false });
  expect(handlers.onFollowUp).toHaveBeenCalledTimes(1);
  expect(handlers.onFollowUp).toHaveBeenCalledWith("为什么？");
});

test("IME confirmation does not send a margin comment until composition ends", async () => {
  const { MarginNotes } =
    await import("@/components/legal-reader/margin-notes");
  const onSubmit = mock(
    (_body: string, _visibility: "private" | "shared") => undefined,
  );
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <MarginNotes
        placement="inline"
        items={[
          {
            kind: "composer",
            id: "comment-composer",
            startAnchorId: "p-2",
            targetType: "decision",
            onSubmit,
            onCancel: () => undefined,
          },
        ]}
      />
    </IntlProvider>,
  );
  const composer = view.getByRole("textbox", { name: messages.folio.comment });
  fireEvent.change(composer, { target: { value: "Příliš žluťoučký" } });
  fireEvent.compositionStart(composer);
  fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
  expect(onSubmit).toHaveBeenCalledTimes(0);
  fireEvent.compositionEnd(composer);
  fireEvent.keyDown(composer, { key: "Enter", isComposing: false });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith("Příliš žluťoučký", "private");
});

test("an offscreen card minimises and its preview reopens the thread", () => {
  const { getByRole, queryByRole, handlers, container } = mount();
  const callback = observers.at(0);
  const node = container.querySelector("section");
  if (callback === undefined || node === null) {
    throw new Error("Expected observed card");
  }
  const bounds = node.getBoundingClientRect();
  const observer = new VisibilityObserver(() => undefined);
  act(() =>
    callback(
      [
        {
          target: node,
          isIntersecting: false,
          intersectionRatio: 0,
          time: 0,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
        },
      ],
      observer,
    ),
  );
  expect(queryByRole("textbox")).toBeNull();
  fireEvent.click(getByRole("button", { name: "An explanation." }));
  expect(getByRole("textbox")).toBeDefined();
  expect(handlers.onOpen).toHaveBeenCalledTimes(1);
});

test("revealing an already visible card still lets it minimise when the reader scrolls away", async () => {
  initialVisibility = "visible";
  const { container, queryByRole } = mount({ active: true, openRevision: 1 });
  const node = container.querySelector("section");
  const callback = observers.at(0);
  if (node === null || callback === undefined) {
    throw new TypeError("Visible answer must be observed");
  }
  const scroll = mock(() => undefined);
  node.scrollIntoView = scroll;
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
  });
  const bounds = node.getBoundingClientRect();
  act(() =>
    callback(
      [
        {
          target: node,
          isIntersecting: false,
          intersectionRatio: 0,
          time: 0,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
        },
      ],
      new VisibilityObserver(() => undefined),
    ),
  );
  expect(queryByRole("textbox")).toBeNull();
});

test("streaming and failed partial replies remain visible, with typed errors and invalid citation feedback", () => {
  const { getByRole, getByText, queryByRole, rerender, tree, props } = mount({
    busy: true,
    answer: {
      ...answer,
      messages: answer.messages.map((message) => ({
        ...message,
        status: "streaming",
        content: "",
      })),
    },
  });
  expect(getByRole("status").getAttribute("aria-label")).toBe(
    "Generating answer…",
  );
  expect(getByRole("textbox").hasAttribute("disabled")).toBe(true);
  rerender(
    tree({
      ...props,
      busy: false,
      answer: {
        ...answer,
        messages: answer.messages.map((message) => ({
          ...message,
          status: "failed",
          errorCode: "action_period_exhausted",
          invalidCitationCount: 2,
          content: "Partial explanation",
        })),
      },
    }),
  );
  expect(getByText("Partial explanation")).toBeDefined();
  expect(queryByRole("alert")).toBeNull();
  expect(getByText("2 citations could not be verified.")).toBeDefined();
});

test("a persisted timeout leaves actions available without a raw alert", () => {
  const { getByRole, queryByRole, handlers } = mount({
    answer: {
      ...answer,
      messages: answer.messages.map((message) => ({
        ...message,
        status: "failed",
        errorCode: "timeout",
      })),
    },
  });
  expect(queryByRole("alert")).toBeNull();
  const composer = getByRole("textbox", { name: "Ask a follow-up" });
  expect(composer.hasAttribute("disabled")).toBe(false);
  const regenerate = getByRole("button", { name: "Regenerate answer" });
  expect(regenerate.hasAttribute("disabled")).toBe(false);
  fireEvent.change(composer, { target: { value: "Please continue" } });
  fireEvent.click(getByRole("button", { name: "Send follow-up" }));
  fireEvent.click(regenerate);
  expect(handlers.onFollowUp).toHaveBeenCalledWith("Please continue");
  expect(handlers.onRegenerate).toHaveBeenCalledTimes(1);
});

test("shared answers from another author expose citations and copy but no mutation controls", () => {
  const { queryByRole, getByRole } = mount({
    answer: { ...answer, mine: false, visibility: "shared" },
  });
  expect(queryByRole("textbox")).toBeNull();
  expect(queryByRole("button", { name: "Delete" })).toBeNull();
  expect(queryByRole("button", { name: "Regenerate answer" })).toBeNull();
  expect(getByRole("button", { name: "Copy" })).toBeDefined();
});

test("the Arabic card uses the Arabic catalog for region and composer labels", () => {
  const { getByRole } = mount({}, "ar");
  expect(
    getByRole("region", { name: arabicMessages.readerAnswers.title }),
  ).toBeDefined();
  expect(
    getByRole("textbox", { name: arabicMessages.readerAnswers.followUp }),
  ).toBeDefined();
});

test("opening the same active answer again expands its minimised thread and focuses the composer", async () => {
  const { getByRole, queryByRole, rerender, tree, props, container } = mount({
    active: true,
  });
  fireEvent.click(getByRole("button", { name: "Minimise answer" }));
  expect(queryByRole("textbox")).toBeNull();
  rerender(tree({ ...props, openRevision: 1 }));
  const composer = getByRole("textbox");
  // Diffing Happy DOM nodes on each retry blocks the reveal's animation frame.
  await waitFor(() =>
    expect(container.ownerDocument.activeElement === composer).toBe(true),
  );
});

test("opening another answer leaves this minimised card closed", () => {
  const { getByRole, queryByRole, rerender, tree, props } = mount();
  fireEvent.click(getByRole("button", { name: "Minimise answer" }));
  rerender(tree({ ...props, openRevision: 1 }));
  expect(queryByRole("textbox")).toBeNull();
});

test("answer and comment share the canonical gutter placement without overlapping", async () => {
  const { MarginNotes } =
    await import("@/components/legal-reader/margin-notes");
  const { placeGutterNotes } =
    await import("@/components/legal-reader/margin-notes.logic");
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const originalHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    let top = 0;
    if (this.dataset["anchor"] === "p-2") {
      top = 20;
    }
    if (this.dataset["anchor"] === "p-3") {
      top = 30;
    }
    return new DOMRect(0, top, 320, 100);
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 100,
  });
  const ownerDocument = render(<div />).container.ownerDocument;
  cleanup();
  const scroll = ownerDocument.createElement("div");
  scroll.innerHTML =
    '<p data-anchor="p-2">Selected words</p><p data-anchor="p-3">Commented words</p>';
  ownerDocument.body.append(scroll);
  try {
    const { props } = mount();
    cleanup();
    const answerItem = {
      ...props,
      kind: "answer",
      id: answer.id,
      startAnchorId: "p-2",
    } as const;
    const commentItem = {
      kind: "comment",
      id: "comment-1",
      text: "A nearby comment",
      startAnchorId: "p-3",
      author: { name: null, image: null },
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      mine: false,
      targetType: "decision",
      visibility: "private",
      onDelete: () => undefined,
      onToggleVisibility: () => undefined,
    } as const;
    const notes: AnchoredNote<MarginItem>[] = [
      { anchorTop: 20, height: 100, note: answerItem },
      { anchorTop: 30, height: 100, note: commentItem },
    ];
    const expected = placeGutterNotes({ notes, region: { width: 320 } });
    const { container } = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <MarginNotes
            placement="gutter"
            items={[answerItem, commentItem]}
            scrollContainerRef={{ current: scroll }}
          />
        </FormattingProvider>
      </IntlProvider>,
    );
    await waitFor(() => {
      const cards = [
        ...container.querySelectorAll<HTMLElement>("[data-margin-note] > div"),
      ];
      expect(cards.map((card) => card.style.top)).toEqual(
        expected.map(({ top }) => `${top}px`),
      );
      expect(cards.length).toBe(2);
      const first = expected.at(0);
      const second = expected.at(1);
      if (first === undefined || second === undefined) {
        throw new Error("Expected both placements");
      }
      expect(second.top).toBeGreaterThanOrEqual(first.top + 100);
    });
  } finally {
    cleanup();
    scroll.remove();
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    if (originalHeight !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        originalHeight,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
  }
});
