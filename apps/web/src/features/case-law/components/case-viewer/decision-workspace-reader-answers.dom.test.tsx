import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";
import { DetachedWindowAPI } from "happy-dom";

import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import type {
  ReaderAnswer,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";
import {
  type DecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import type { AnalysisQueryResult } from "@/features/case-law/queries/decision-analysis";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
// Match Vite's emitted worker URL without loading worker code on the DOM thread.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const originalFetch = globalThis.fetch;
// Importing auth starts its session prefetch before the per-test transport.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toSafeId } = await import("@/lib/safe-id");
const { decisionAnalysisOptions } =
  await import("@/features/case-law/queries/decision-analysis");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { DecisionWorkspace } = await import("./decision-workspace");
const { readerAnswersOptions } = await import("./reader-answers-query");

const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const originalScroll = HTMLElement.prototype.scrollIntoView;
const originalRangeRects = Range.prototype.getClientRects;
const originalObserver = globalThis.IntersectionObserver;
const observers = new Map<
  Element,
  { callback: IntersectionObserverCallback; observer: IntersectionObserver }
>();
class VisibilityObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    observers.set(target, { callback: this.callback, observer: this });
  }
  unobserve(target: Element) {
    observers.delete(target);
  }
  disconnect() {
    for (const [target, registration] of observers) {
      if (registration.observer === this) {
        observers.delete(target);
      }
    }
  }
  takeRecords() {
    return [];
  }
}
const reportVisibility = (node: HTMLElement, isIntersecting: boolean) => {
  const registration = observers.get(node);
  if (!registration) {
    throw new TypeError("Answer must have a visibility observer");
  }
  const bounds = node.getBoundingClientRect();
  act(() =>
    registration.callback(
      [
        {
          target: node,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
        },
      ],
      registration.observer,
    ),
  );
};
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const clients: InstanceType<typeof QueryClient>[] = [];
const { document: testDocument, window: testWindow } = globalThis;
afterEach(async () => {
  testDocument.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
  HTMLElement.prototype.scrollIntoView = originalScroll;
  Range.prototype.getClientRects = originalRangeRects;
  globalThis.IntersectionObserver = originalObserver;
  observers.clear();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  if (originalHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalHeight,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  }
});
afterAll(async () => {
  if (
    !("happyDOM" in testWindow) ||
    !(testWindow.happyDOM instanceof DetachedWindowAPI)
  ) {
    throw new TypeError("Missing HappyDOM browser lifecycle");
  }
  await testWindow.happyDOM.close();
});

const user = {
  activeOrganizationId: "test-org",
  id: "test-reader",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const passage = "The court gives its reasons.";
const ast = {
  version: 1,
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  blocks: ["p-1", "p-2"].map((id) => ({
    id,
    anchorId: id,
    type: "paragraph" as const,
    plainText: passage,
    inlines: [{ type: "text" as const, text: passage }],
  })),
} satisfies DocumentAst;
const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;
const decision = {
  appealReviews: noDecisionReviewFound(),
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000002"),
  caseNumber: "1 As 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Test court",
  courtAbbreviation: null,
  courtTier: "other",
  decisionDate: null,
  decisionType: "Judgment",
  ecli: null,
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  judges: [],
  language: "cs",
  metadata: {},
  sourceAttributionUrl: null,
  source: {
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000003"),
    name: "Test publisher",
    adapterKey: "test",
    allowsDerivedAi: false,
  },
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
  updatedAt: "2026-10-10T12:00:00Z",
} satisfies ComponentProps<typeof DecisionWorkspace>["decision"];
const answer = {
  id: toSafeId<"legalReaderAnswer">("00000000-0000-4000-8000-000000000004"),
  decisionId: decision.id,
  authorId: toSafeId<"user">(user.id),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: {
    spans: [
      {
        paragraphId: "p-2",
        quote: passage,
        startOffset: 0,
        endOffset: passage.length,
      },
    ],
  },
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">(
        "00000000-0000-4000-8000-000000000005",
      ),
      role: "assistant",
      content: "An explanation.",
      citations: [],
      model: "test",
      usage: null,
      status: "complete",
      errorCode: null,
      invalidCitationCount: 0,
      createdAt: decision.updatedAt,
      updatedAt: decision.updatedAt,
    },
  ],
  createdAt: decision.updatedAt,
  updatedAt: decision.updatedAt,
} satisfies ReaderAnswer;
const analysis = {
  version: 2,
  generatedAt: decision.updatedAt,
  model: "test",
  inputFingerprint: "a".repeat(64),
  tree: ["first-note", "second-note", "third-note"].map((id) => ({
    id,
    label: id,
    category: "reasoning" as const,
    startAnchorId: "p-1",
    endAnchorId: "p-1",
    annotations: [],
    children: [],
  })),
} satisfies DecisionAnalysis;

const fakeReaderServer = (initialAnswers: ReaderAnswer[] = [answer]) => {
  let rows = initialAnswers;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const emit = (event: ReaderAnswerStreamEvent) => {
    if (!stream) {
      throw new TypeError("Generation stream must be open");
    }
    stream.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    );
  };
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.includes("/reader/answers")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        });
        emit({
          type: "started",
          answerId: answer.id,
          messageId: toSafeId<"legalReaderAnswerMessage">(
            "00000000-0000-4000-8000-000000000006",
          ),
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (path.endsWith("/reader/answers")) {
        return Response.json({ items: rows, nextCursor: null, limit: 50 });
      }
      if (path.endsWith("/provisions")) {
        return Response.json({
          items: [],
          previews: [],
          nextCursor: null,
          status: { type: "current" },
          generation: null,
        });
      }
      if (path.endsWith("/reader/annotations") || path.endsWith("/citations")) {
        return Response.json({ items: [], nextCursor: null });
      }
      if (/\/chat\/threads\/[^/]+\/messages$/u.test(path)) {
        return Response.json({ message: "Not found" }, { status: 404 });
      }
      if (path.endsWith("/workspaces/navigation")) {
        return Response.json({ items: [], nextCursor: null, workspaces: [] });
      }
      if (path.endsWith("/organization-settings/ai-availability")) {
        return Response.json(aiAvailableResponse());
      }
      throw new TypeError(`Unexpected request: ${request.method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    requests,
    complete: () => {
      rows = [answer];
      emit({
        type: "complete",
        messageId: toSafeId<"legalReaderAnswerMessage">(
          "00000000-0000-4000-8000-000000000006",
        ),
        content: "An explanation.",
        citations: [],
        invalidCitationCount: 0,
        model: "test",
        usage: null,
      });
      stream?.close();
    },
  };
};

const renderWorkspace = async (
  client: InstanceType<typeof QueryClient>,
  aiMode: "enabled" | "gated" = "gated",
) => {
  const root = createRootRoute({
    component: () => (
      <ChatEditorProvider>
        <DecisionWorkspace
          decision={decision}
          decisionId={decision.id}
          {...(aiMode === "enabled"
            ? { aiMode, ensureAIAvailable: async () => true }
            : { aiMode })}
        />
      </ChatEditorProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider user={user}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <ActionCapabilitiesProvider
              value={resolveActionCapabilities({
                role: "member",
                ai: true,
                deepl: false,
                ocr: DOCUMENT_OCR_AVAILABILITY.unconfigured,
                desktop: "none",
                settings: undefined,
              })}
            >
              <WebReaderPresentationProvider>
                <RouterProvider router={router} />
              </WebReaderPresentationProvider>
            </ActionCapabilitiesProvider>
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
};

const installDisplacedLayout = () => {
  // HappyDOM has no layout: supply paragraph positions and measured note heights;
  // the real gutter placement still decides each card's resulting top.
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches(".reader-scroll")) {
      return new DOMRect(0, 0, 1000, 400);
    }
    if (this.dataset["anchor"] === "p-1") {
      return new DOMRect(320, 80, 680, 40);
    }
    if (this.dataset["anchor"] === "p-2") {
      return new DOMRect(320, 120, 680, 40);
    }
    if (this.dataset["readerAnswerId"] !== undefined) {
      return new DOMRect(
        0,
        Number.parseFloat(this.parentElement?.style.top ?? "0"),
        300,
        250,
      );
    }
    if (this.closest("[data-reader-notes-column]")) {
      return new DOMRect(0, 0, 300, 1200);
    }
    return new DOMRect(0, 0, 1000, 400);
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.closest('[data-margin-note="card"]') ? 250 : 100;
    },
  });
};

const seedAnalysis = (client: InstanceType<typeof QueryClient>) => {
  const persistedAnalysis = parsePersistedDecisionAnalysis(analysis);
  if (persistedAnalysis === null || "status" in persistedAnalysis) {
    throw new TypeError("Completed analysis fixture must parse");
  }
  client.setQueryData(
    decisionAnalysisOptions({
      decisionId: decision.id,
      decisionUpdatedAt: decision.updatedAt,
    }).queryKey,
    () =>
      ({
        kind: "done",
        analysis: persistedAnalysis,
      }) satisfies AnalysisQueryResult,
  );
};

test("opening a passage answer reveals its expanded gutter card below preceding notes", async () => {
  installDisplacedLayout();
  fakeReaderServer();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  seedAnalysis(client);
  // A member can retain answers while the account's AI availability is gated.
  // This exercises the reader without activating the unrelated chat overlay.
  client.setQueryData(
    readerAnswersOptions({
      decisionId: decision.id,
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    [answer],
  );
  const view = await renderWorkspace(client);
  const card = await view.findByRole("region", {
    name: messages.readerAnswers.title,
  });
  const reader = card.closest<HTMLElement>(".reader-scroll");
  if (reader === null) {
    throw new TypeError("Answer card must belong to reader viewport");
  }
  await waitFor(() =>
    expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      reader.getBoundingClientRect().bottom,
    ),
  );
  expect(
    view.container.querySelectorAll('[data-margin-note="card"]'),
  ).toHaveLength(3);
  fireEvent.click(
    within(card).getByRole("button", { name: messages.readerAnswers.minimise }),
  );
  expect(
    within(card)
      .getByRole("button", { name: messages.readerAnswers.expand })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  const scrolls: {
    target: HTMLElement;
    options: boolean | ScrollIntoViewOptions | undefined;
    expanded: boolean;
  }[] = [];
  card.scrollIntoView = (options) => {
    scrolls.push({
      target: card,
      options,
      expanded:
        within(card)
          .getByRole("button", { name: messages.readerAnswers.minimise })
          .getAttribute("aria-expanded") === "true",
    });
  };
  const marker = reader.querySelector<HTMLButtonElement>(
    `[data-reader-answer-marker="${answer.id}"]`,
  );
  if (marker === null) {
    throw new TypeError("Answer passage marker must exist");
  }
  fireEvent.click(marker);
  await waitFor(() => expect(scrolls).toHaveLength(1));
  const scroll = scrolls.at(0);
  expect(scroll?.target).toBe(card);
  expect(scroll?.options).toEqual({ behavior: "instant", block: "nearest" });
  expect(scroll?.expanded).toBe(true);
});

test("a gated reader loads saved explanations from an empty cache without offering mutations", async () => {
  const { requests } = fakeReaderServer();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  const view = await renderWorkspace(client);
  const card = await view.findByRole("region", {
    name: messages.readerAnswers.title,
  });
  const reads = requests.filter((request) =>
    new URL(request.url).pathname.endsWith("/reader/answers"),
  );
  expect(reads).toHaveLength(1);
  const read = reads.at(0);
  if (read === undefined) {
    throw new TypeError("Persisted answers must load through HTTP");
  }
  expect(read.method).toBe("GET");
  expect(new URL(read.url).searchParams.get("decisionId")).toBe(decision.id);
  expect(within(card).getByText("An explanation.")).toBeDefined();
  expect(
    within(card).queryByRole("textbox", {
      name: messages.readerAnswers.followUp,
    }),
  ).toBeNull();
  expect(
    within(card).queryByRole("button", {
      name: messages.readerAnswers.regenerate,
    }),
  ).toBeNull();
  expect(
    within(card).queryByRole("button", { name: messages.common.delete }),
  ).toBeNull();
  expect(
    within(card).queryByRole("button", { name: messages.readerAnswers.share }),
  ).toBeNull();
});

for (const activation of ["create", "regenerate", "follow-up"]) {
  test(`${activation} reveals the expanded answer after gutter placement and keeps it open after generation`, async () => {
    installDisplacedLayout();
    globalThis.IntersectionObserver = VisibilityObserver;
    Range.prototype.getClientRects = () => {
      const rect = new DOMRect(320, 120, 100, 20);
      return {
        length: 1,
        item: () => rect,
        [Symbol.iterator]: () => [rect][Symbol.iterator](),
      };
    };
    const server = fakeReaderServer(activation === "create" ? [] : [answer]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    seedAnalysis(client);
    const scrolls: { card: HTMLElement; top: number; expanded: boolean }[] = [];
    HTMLElement.prototype.scrollIntoView = function () {
      if (this.dataset["readerAnswerId"] === answer.id) {
        scrolls.push({
          card: this,
          top: this.getBoundingClientRect().top,
          expanded:
            within(this)
              .getByRole("button", { name: messages.readerAnswers.minimise })
              .getAttribute("aria-expanded") === "true",
        });
      }
    };
    const view = await renderWorkspace(client, "enabled");
    await waitFor(() =>
      expect(
        view.container.querySelectorAll('[data-margin-note="card"]'),
      ).toHaveLength(3),
    );
    if (activation === "create") {
      const paragraph = view.container.querySelector('[data-anchor="p-2"]');
      if (!paragraph) {
        throw new TypeError("Selected passage must exist");
      }
      const range = testDocument.createRange();
      range.selectNodeContents(paragraph);
      const selection = testDocument.getSelection();
      if (!selection) {
        throw new TypeError("Reader selection must exist");
      }
      act(() => {
        selection.removeAllRanges();
        selection.addRange(range);
        testDocument.dispatchEvent(new Event("selectionchange"));
      });
      fireEvent.click(
        await view.findByRole("button", {
          name: messages.readerAnswers.explain,
        }),
      );
    } else {
      const card = await view.findByRole("region", {
        name: messages.readerAnswers.title,
      });
      if (activation === "regenerate") {
        fireEvent.click(
          within(card).getByRole("button", {
            name: messages.readerAnswers.regenerate,
          }),
        );
      } else {
        fireEvent.change(
          within(card).getByRole("textbox", {
            name: messages.readerAnswers.followUp,
          }),
          { target: { value: "Why?" } },
        );
        fireEvent.click(
          within(card).getByRole("button", {
            name: messages.readerAnswers.send,
          }),
        );
      }
    }
    await waitFor(() => expect(scrolls).toHaveLength(1));
    const reveal = scrolls.at(0);
    if (!reveal) {
      throw new TypeError("Activated answer must be revealed");
    }
    expect(reveal.top).toBeGreaterThanOrEqual(400);
    expect(reveal.expanded).toBe(true);
    // An offscreen sample queued before the reveal must not close the result.
    reportVisibility(reveal.card, false);
    act(() => server.complete());
    await waitFor(() =>
      expect(reveal.card.getAttribute("aria-busy")).toBe("false"),
    );
    expect(
      within(reveal.card).getByRole("textbox", {
        name: messages.readerAnswers.followUp,
      }),
    ).toBeDefined();
    expect(within(reveal.card).getAllByText("An explanation.")).toBeDefined();
    reportVisibility(reveal.card, true);
    reportVisibility(reveal.card, false);
    expect(within(reveal.card).queryByRole("textbox")).toBeNull();
    fireEvent.click(
      within(reveal.card).getByRole("button", { name: "An explanation." }),
    );
    await waitFor(() => expect(scrolls).toHaveLength(2));
    expect(
      within(reveal.card).getByRole("textbox", {
        name: messages.readerAnswers.followUp,
      }),
    ).toBeDefined();
  });
}
