import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import { DetachedWindowAPI } from "happy-dom";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import { READER_ANSWER_DEADLINE_MS } from "@stll/api-contract/reader-answers";
import type {
  ReaderAnswer,
  ReaderAnswerAnchor,
  ReaderAnswerErrorCode,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";
import { sleep } from "@stll/concurrency/sleep";
import { rejectionOf } from "@stll/property-testing/rejection";
import { Temporal } from "@stll/time";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { StrictMode, useRef } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { IntlProvider: MessagesProvider } = await import("use-intl");
const { default: csMessages } = await import("@/i18n/langs/cs.json");
const { toSafeId } = await import("@/lib/safe-id");
const { useReaderAnswers } = await import("./use-reader-answers");
const {
  applyReaderAnswerEvent,
  readerAnswerFailureKind,
  readerAnswerErrorCodeKind,
} = await import("./reader-answers.logic");
const { readerAnswersOptions } = await import("./reader-answers-query");

const { document: testDocument, window: testWindow } = globalThis;
const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  testDocument.getSelection()?.removeAllRanges();
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  // The DOM runner isolates this file. Shared UI roots can queue React work
  // after close, so retain their browser globals while releasing browser tasks.
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
  id: "test-user",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const span = {
  paragraphId: "paragraph-1",
  quote: "Selected text",
  startOffset: 0,
  endOffset: 13,
};
const anchor: ReaderAnswerAnchor = { spans: [span] };
const now = "2026-10-10T12:00:00.000Z";

const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider user={user}>
          <MessagesProvider locale="cs" messages={csMessages} timeZone="UTC">
            <FormattingProvider locale="cs" timeZone="UTC">
              {children}
            </FormattingProvider>
          </MessagesProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  return { client, wrapper };
};

const fakeServer = (
  failRegenerate = false,
  errorCode: ReaderAnswerErrorCode = "provider-error",
) => {
  let rows: ReaderAnswer[] = [];
  let sequence = 0;
  const bodies: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        return Response.json({ items: rows, nextCursor: null, limit: 50 });
      }
      if (request.method === "DELETE") {
        rows = [];
        return Response.json({ success: true });
      }
      const body: unknown = await request.json();
      bodies.push(body);
      if (request.method === "PATCH") {
        if (
          typeof body === "object" &&
          body !== null &&
          "visibility" in body &&
          (body.visibility === "private" || body.visibility === "shared")
        ) {
          const visibility = body.visibility;
          rows = rows.map((row) => ({ ...row, visibility }));
        }
        return Response.json(rows.at(0));
      }
      sequence += 1;
      const regenerate = path.endsWith("/regenerate");
      const initial =
        rows.at(0) ??
        ({
          id: toSafeId<"legalReaderAnswer">("answer-1"),
          decisionId: toSafeId<"caseLawDecision">("decision-1"),
          authorId: toSafeId<"user">(user.id),
          mine: true,
          kind: "explain",
          anchor,
          visibility: "private",
          messages: [],
          createdAt: now,
          updatedAt: now,
        } satisfies ReaderAnswer);
      const messageId = toSafeId<"legalReaderAnswerMessage">(
        `assistant-${sequence}`,
      );
      const events = [
        { type: "started", answerId: initial.id, messageId },
        { type: "delta", messageId, delta: "draft" },
        failRegenerate && regenerate
          ? {
              type: "failed",
              errorCode,
              messageId,
              message: "Provider failed",
              content: "Sanitized partial",
              citations: [
                { decisionId: initial.decisionId, paragraphId: "paragraph-2" },
              ],
              invalidCitationCount: 1,
            }
          : {
              type: "complete",
              messageId,
              content: `Answer ${sequence}`,
              citations: [
                { decisionId: initial.decisionId, paragraphId: "paragraph-2" },
              ],
              invalidCitationCount: 0,
              model: "test-model",
              usage: null,
            },
      ] satisfies ReaderAnswerStreamEvent[];
      let persisted = initial;
      for (const event of events) {
        persisted = applyReaderAnswerEvent({
          answer: persisted,
          event,
          regenerate,
          now,
        });
      }
      rows = [persisted];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return { bodies };
};

test("a response with the wrong stream content type cancels its body and releases creation", async () => {
  let cancelled = false;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json({ items: [], nextCursor: null, limit: 50 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("Unexpected response"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/plain" } },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const { wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => {
    await hook.result.current.createExplain(anchor);
  });
  expect(cancelled).toBe(true);
  expect(hook.result.current.errors.get("create")).toMatchObject({
    kind: "protocol",
    message: "Missing reader answer stream",
  });
  const creationError =
    hook.result.current.errors.get("create") ??
    panic("Expected creation failure");
  expect(hook.result.current.failureNotices).toEqual([
    { type: "operation", error: creationError },
  ]);
  expect(hook.result.current.isCreating).toBe(false);
  expect(hook.result.current.busyAnswerIds.size).toBe(0);
});

test("reader answers create, follow up, regenerate, share, reload and delete through the HTTP boundary", async () => {
  const server = fakeServer();
  const { wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => {
    await hook.result.current.createExplain(anchor);
  });
  expect(hook.result.current.answers.at(0)).toMatchObject({
    anchor,
    visibility: "private",
    messages: [{ content: "Answer 1", status: "complete" }],
  });
  expect(server.bodies.at(0)).toEqual({
    decisionId: "decision-1",
    kind: "explain",
    anchor,
    locale: "cs",
  });
  expect(hook.result.current.activeAnswerId).toBe("answer-1");
  await act(async () => {
    await hook.result.current.followUp("answer-1", "What follows?");
  });
  expect(hook.result.current.answers.at(0)?.messages).toHaveLength(2);
  await act(async () => {
    await hook.result.current.regenerate("answer-1");
  });
  expect(
    hook.result.current.answers.at(0)?.messages.map((message) => message.id),
  ).toEqual([
    toSafeId<"legalReaderAnswerMessage">("assistant-1"),
    toSafeId<"legalReaderAnswerMessage">("assistant-3"),
  ]);
  await act(async () => {
    await hook.result.current.setVisibility("answer-1", "shared");
  });
  expect(hook.result.current.answers.at(0)?.visibility).toBe("shared");
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper: reload.wrapper },
  );
  await waitFor(() =>
    expect(
      reloaded.result.current.answers.at(0)?.messages.at(-1)?.content,
    ).toBe("Answer 3"),
  );
  expect(reloaded.result.current.answers.at(0)?.visibility).toBe("shared");
  await act(async () => {
    await reloaded.result.current.remove("answer-1");
  });
  expect(reloaded.result.current.answers).toEqual([]);
});

test("failed regeneration keeps one fresh assistant and sanitized partials survive reload", async () => {
  fakeServer(true);
  const { wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => {
    await hook.result.current.createExplain(anchor);
  });
  await act(async () => {
    await hook.result.current.regenerate("answer-1");
  });
  expect(hook.result.current.answers.at(0)?.messages).toHaveLength(1);
  expect(hook.result.current.answers.at(0)?.messages.at(0)).toMatchObject({
    id: "assistant-2",
    content: "Sanitized partial",
    status: "failed",
  });
  expect(hook.result.current.errors.get("answer-1")).toBeUndefined();
  expect(hook.result.current.failureNotices).toMatchObject([
    {
      type: "message",
      messageId: "assistant-2",
      error: { code: "provider-error" },
    },
  ]);
  expect(
    hook.result.current.answers.at(0)?.messages.at(-1)?.invalidCitationCount,
  ).toBe(1);
  expect(hook.result.current.busyAnswerIds.size).toBe(0);
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper: reload.wrapper },
  );
  await waitFor(() =>
    expect(reloaded.result.current.answers.at(0)?.messages.at(0)?.content).toBe(
      "Sanitized partial",
    ),
  );
  expect(reloaded.result.current.answers.at(0)?.messages).toHaveLength(1);
  expect(reloaded.result.current.answers.at(0)?.messages.at(0)).toMatchObject({
    status: "failed",
    errorCode: "provider-error",
    invalidCitationCount: 1,
  });
  expect(reloaded.result.current.errors.size).toBe(0);
  expect(reloaded.result.current.failureNotices).toMatchObject([
    {
      type: "message",
      messageId: "assistant-2",
      error: { code: "provider-error" },
    },
  ]);
});

// oxlint-disable-next-line require-contract-domains/require-contract-domains -- These are tested reader actions, not API domain values.
test.each(["create", "follow-up", "regenerate"] as const)(
  "a truncated %s stream yields to the authoritative terminal answer without a stale card error",
  async (action) => {
    fakeServer(true);
    const baseFetch = globalThis.fetch;
    const { wrapper } = setup();
    const hook = renderHook(
      () =>
        useReaderAnswers({
          decisionId: "decision-1",
          generationMode: "enabled",
        }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    if (action !== "create") {
      await act(async () => {
        await hook.result.current.createExplain(anchor);
      });
    }
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await baseFetch(input, init);
        const request = new Request(input, init);
        if (request.method !== "POST") {
          return response;
        }
        await response.body?.cancel();
        const started = {
          type: "started",
          answerId: toSafeId<"legalReaderAnswer">("answer-1"),
          messageId: toSafeId<"legalReaderAnswerMessage">(
            action === "create" ? "assistant-1" : "assistant-2",
          ),
        } as const satisfies ReaderAnswerStreamEvent;
        return new Response(`data: ${JSON.stringify(started)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    await act(async () => {
      switch (action) {
        case "create":
          await hook.result.current.createExplain(anchor);
          break;
        case "follow-up":
          await hook.result.current.followUp("answer-1", "What follows?");
          break;
        case "regenerate":
          await hook.result.current.regenerate("answer-1");
          break;
      }
    });
    const expectedContent = {
      create: "Answer 1",
      "follow-up": "Answer 2",
      regenerate: "Sanitized partial",
    } as const satisfies Record<typeof action, string>;
    const content = expectedContent[action];
    await waitFor(() =>
      expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
        content,
      ),
    );
    const answer = hook.result.current.answers.at(0);
    if (!answer) {
      throw new TypeError("Missing reconciled reader answer");
    }
    const { IntlProvider } = await import("use-intl");
    const { default: messages } = await import("@/i18n/langs/en.json");
    const { ReaderAnswerCard } = await import("./reader-answer-card");
    const view = render(
      <IntlProvider locale="en" messages={messages}>
        <ReaderAnswerCard
          answer={answer}
          generationMode="enabled"
          active={false}
          openRevision={0}
          busy={false}
          onOpen={() => undefined}
          onFollowUp={() => undefined}
          onRegenerate={() => undefined}
          onDelete={() => undefined}
          onVisibility={() => undefined}
          onCitation={() => undefined}
          citationTarget={() => ({ type: "unresolved" })}
          language="en"
        />
      </IntlProvider>,
    );
    expect(view.getByText(content)).toBeTruthy();
    expect(view.queryByRole("alert")).toBeNull();
    expect(hook.result.current.errors.size).toBe(0);
    expect(hook.result.current.error).toBeNull();
  },
);

// oxlint-disable-next-line require-contract-domains/require-contract-domains -- These are tested reader actions, not API domain values.
test.each(["follow-up", "regenerate", "share", "delete"] as const)(
  "reading an older completed answer preserves a rejected %s operation error",
  async (action) => {
    fakeServer();
    const baseFetch = globalThis.fetch;
    const { client, wrapper } = setup();
    const hook = renderHook(
      () =>
        useReaderAnswers({
          decisionId: "decision-1",
          generationMode: "enabled",
        }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    await act(async () => {
      await hook.result.current.createExplain(anchor);
    });
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        return request.method === "GET"
          ? await baseFetch(input, init)
          : Response.json(
              { message: "Operation unavailable" },
              { status: 503 },
            );
      },
      { preconnect: originalFetch.preconnect },
    );
    await act(async () => {
      switch (action) {
        case "follow-up":
          await hook.result.current.followUp("answer-1", "What follows?");
          break;
        case "regenerate":
          await hook.result.current.regenerate("answer-1");
          break;
        case "share":
          await hook.result.current.setVisibility("answer-1", "shared");
          break;
        case "delete":
          await hook.result.current.remove("answer-1");
          break;
      }
      await client.invalidateQueries({ queryKey: ["reader-answers"] });
    });
    expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
      "Answer 1",
    );
    expect(
      readerAnswerFailureKind(hook.result.current.errors.get("answer-1")),
    ).toBe("model");
  },
);

test("switching decision discards a delayed stream before it can activate an old card", async () => {
  const server = fakeServer();
  const baseFetch = globalThis.fetch;
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        await paused;
      }
      return baseFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { wrapper } = setup();
  const hook = renderHook(
    ({ decisionId }) =>
      useReaderAnswers({ decisionId, generationMode: "enabled" }),
    { wrapper, initialProps: { decisionId: "decision-1" } },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let pending: Promise<void> | undefined;
  act(() => {
    pending = hook.result.current.createExplain(anchor);
  });
  await waitFor(() => expect(hook.result.current.isCreating).toBe(true));
  hook.rerender({ decisionId: "decision-2" });
  await act(async () => {
    release?.();
    await pending;
  });
  expect(hook.result.current.activeAnswerId).toBeNull();
  expect(hook.result.current.isCreating).toBe(false);
  expect(hook.result.current.answers).toEqual([]);
  expect(server.bodies).toHaveLength(1);
});

test("selecting decision text and clicking Explain opens the persisted margin answer card", async () => {
  const server = fakeServer();
  const { IntlProvider } = await import("use-intl");
  const { default: messages } = await import("@/i18n/langs/en.json");
  const { AnnotationToolbar } =
    await import("@/components/legal-reader/annotations/annotation-toolbar");
  const { ReaderAnswerCard } = await import("./reader-answer-card");
  const { ActionCapabilitiesProvider } =
    await import("@/lib/organization/feature-access/capability-actions");
  const { resolveActionCapabilities } =
    await import("@/lib/organization/feature-access/action-capabilities.logic");

  const SelectionReader = () => {
    const root = useRef<HTMLElement>(null);
    const answers = useReaderAnswers({
      decisionId: "decision-1",
      generationMode: "enabled",
    });
    return (
      <>
        <article ref={root} style={{ overflow: "visible" }}>
          <p data-anchor={span.paragraphId}>{span.quote}</p>
        </article>
        <AnnotationToolbar
          activeAnnotation={null}
          activeSpans={[]}
          controller={{
            create: async () => Result.ok(undefined),
            redo: async () => undefined,
            remove: async () => Result.ok(undefined),
            undo: async () => undefined,
            update: async () => Result.ok(undefined),
          }}
          mode="authenticated"
          onClearActive={() => undefined}
          onActivateAnnotation={() => undefined}
          scrollContainerRef={root}
          target={{
            type: "decision",
            id: "decision-1",
            caseNumber: "Test decision",
            caseNumberType: "case-number",
            country: "CZ",
            court: "Court",
            decisionDate: null,
            decisionType: null,
            ecli: null,
            name: null,
          }}
          onExplain={(spans) => {
            const selected = spans.at(0);
            if (selected) {
              void answers.createExplain({
                spans: [
                  {
                    paragraphId: selected.blockAnchorId,
                    quote: selected.quote,
                    startOffset: selected.startOffset,
                    endOffset: selected.endOffset,
                  },
                ],
              });
            }
          }}
        />
        {answers.answers.map((answer) => (
          <ReaderAnswerCard
            key={answer.id}
            answer={answer}
            generationMode="enabled"
            active={answers.activeAnswerId === answer.id}
            openRevision={answers.openRevision}
            onOpen={() => answers.activateAnswer(answer.id)}
            onFollowUp={(question) => {
              void answers.followUp(answer.id, question);
            }}
            onRegenerate={() => {
              void answers.regenerate(answer.id);
            }}
            onDelete={() => {
              void answers.remove(answer.id);
            }}
            onVisibility={(visibility) => {
              void answers.setVisibility(answer.id, visibility);
            }}
            onCitation={() => undefined}
            citationTarget={() => ({ type: "unresolved" })}
            language="en"
            busy={answers.busyAnswerIds.has(answer.id)}
          />
        ))}
      </>
    );
  };

  const { wrapper: Wrapper } = setup();
  const previousRangeRects = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getClientRects",
  );
  const previousElementRects = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => {
      const rect = new DOMRect(20, 40, 100, 20);
      return {
        length: 1,
        item: () => rect,
        [Symbol.iterator]: () => [rect][Symbol.iterator](),
      };
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 1000, 800),
  });
  try {
    const view = render(
      <Wrapper>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
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
            <SelectionReader />
          </ActionCapabilitiesProvider>
        </IntlProvider>
      </Wrapper>,
    );
    const paragraph = view.container.querySelector("[data-anchor]");
    if (!paragraph) {
      throw new TypeError("Missing selected paragraph fixture");
    }
    const range = testDocument.createRange();
    range.selectNodeContents(paragraph);
    const selection = testDocument.getSelection();
    if (!selection) {
      throw new TypeError("Missing DOM selection");
    }
    act(() => {
      selection.removeAllRanges();
      selection.addRange(range);
      testDocument.dispatchEvent(new Event("selectionchange"));
    });
    const explain = await view.findByRole("button", {
      name: messages.readerAnswers.explain,
    });
    fireEvent.click(explain);
    await waitFor(() => expect(view.getByText("Answer 1")).toBeTruthy());
    expect(view.getByRole("region")).toBeTruthy();
    expect(server.bodies.at(0)).toEqual({
      decisionId: "decision-1",
      kind: "explain",
      anchor,
      locale: "en",
    });
  } finally {
    testDocument.getSelection()?.removeAllRanges();
    if (previousRangeRects) {
      Object.defineProperty(
        Range.prototype,
        "getClientRects",
        previousRangeRects,
      );
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
    if (previousElementRects) {
      Object.defineProperty(
        HTMLElement.prototype,
        "getBoundingClientRect",
        previousElementRects,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
    }
  }
});

test("list invalidation cannot overwrite an active answer stream and terminal reload restores durable messages", async () => {
  let listRequests = 0;
  let persisted: ReaderAnswer[] = [];
  let release: (() => void) | undefined;
  const messageId = toSafeId<"legalReaderAnswerMessage">("pending-assistant");
  const row = {
    id: toSafeId<"legalReaderAnswer">("answer-1"),
    decisionId: toSafeId<"caseLawDecision">("decision-1"),
    authorId: toSafeId<"user">(user.id),
    mine: true,
    kind: "explain",
    anchor,
    visibility: "private",
    messages: [
      {
        id: toSafeId<"legalReaderAnswerMessage">("durable-user"),
        role: "user",
        content: "Explain the selection",
        citations: [],
        status: "complete",
        errorCode: null,
        invalidCitationCount: 0,
        model: null,
        usage: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  } satisfies ReaderAnswer;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        listRequests += 1;
        return Response.json({ items: persisted, nextCursor: null, limit: 50 });
      }
      const started = {
        type: "started",
        answerId: row.id,
        messageId,
      } as const satisfies ReaderAnswerStreamEvent;
      persisted = [
        applyReaderAnswerEvent({
          answer: row,
          event: started,
          regenerate: false,
          now,
        }),
      ];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: ReaderAnswerStreamEvent) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          emit(started);
          emit({ type: "delta", messageId, delta: "Visible partial" });
          release = () => {
            const complete = {
              type: "complete",
              messageId,
              content: "Durable complete",
              citations: [],
              invalidCitationCount: 0,
              model: "test-model",
              usage: null,
            } as const satisfies ReaderAnswerStreamEvent;
            const answer = persisted.at(0);
            if (!answer) {
              throw new TypeError("Missing persisted stream fixture");
            }
            persisted = [
              applyReaderAnswerEvent({
                answer,
                event: complete,
                regenerate: false,
                now,
              }),
            ];
            emit(complete);
            controller.close();
          };
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { client, wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let pending: Promise<void> | undefined;
  act(() => {
    pending = hook.result.current.createExplain(anchor);
  });
  await waitFor(() =>
    expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
      "Visible partial",
    ),
  );
  const requestsBeforeInvalidation = listRequests;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["reader-answers"] });
  });
  expect(listRequests).toBe(requestsBeforeInvalidation);
  expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
    "Visible partial",
  );
  await act(async () => {
    release?.();
    await pending;
  });
  await waitFor(() =>
    expect(
      hook.result.current.answers.at(0)?.messages.map((message) => message.id),
    ).toEqual([
      toSafeId<"legalReaderAnswerMessage">("durable-user"),
      toSafeId<"legalReaderAnswerMessage">("pending-assistant"),
    ]),
  );
  expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
    "Durable complete",
  );
  expect(listRequests).toBeGreaterThan(requestsBeforeInvalidation);
});

test("stream admission exhaustion stays a budget failure after reload", async () => {
  fakeServer(true, "action_period_exhausted");
  const { wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  await act(async () => {
    await hook.result.current.createExplain(anchor);
  });
  await act(async () => {
    await hook.result.current.regenerate("answer-1");
  });
  expect(
    readerAnswerErrorCodeKind(
      hook.result.current.answers.at(0)?.messages.at(-1)?.errorCode ?? null,
    ),
  ).toBe("budget");
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper: reload.wrapper },
  );
  await waitFor(() =>
    expect(reloaded.result.current.answers.at(0)?.messages.at(-1)?.status).toBe(
      "failed",
    ),
  );
  const message = reloaded.result.current.answers.at(0)?.messages.at(-1);
  expect(message?.errorCode).toBe("action_period_exhausted");
  expect(readerAnswerErrorCodeKind(message?.errorCode ?? null)).toBe("budget");
  expect(message?.invalidCitationCount).toBe(1);
});

const pollingServer = (settlement: "complete" | "never" | "hanging") => {
  let row: ReaderAnswer | undefined;
  let listRequests = 0;
  let deletions = 0;
  let completionAvailable = false;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "DELETE") {
        deletions += 1;
        return Response.json({ success: true });
      }
      listRequests += 1;
      if (row === undefined) {
        // oxlint-disable-next-line no-restricted-properties -- The fake HTTP boundary owns this live claim clock; it never runs during SSR.
        const clock = Temporal.Now.instant();
        const claimAt = clock
          .subtract({ milliseconds: READER_ANSWER_DEADLINE_MS - 300 })
          .toString();
        row = {
          id: toSafeId<"legalReaderAnswer">("answer-1"),
          decisionId: toSafeId<"caseLawDecision">("decision-1"),
          authorId: toSafeId<"user">(user.id),
          mine: true,
          kind: "explain",
          anchor,
          visibility: "private",
          createdAt: claimAt,
          updatedAt: claimAt,
          messages: [
            {
              id: toSafeId<"legalReaderAnswerMessage">("persisted-stream"),
              role: "assistant",
              status: "streaming",
              content: "",
              citations: [],
              model: null,
              usage: null,
              errorCode: null,
              invalidCitationCount: 0,
              createdAt: claimAt,
              updatedAt: claimAt,
            },
          ],
        };
      } else if (settlement === "complete" && completionAvailable) {
        row = {
          ...row,
          messages: row.messages.map((message) => ({
            ...message,
            status: "complete",
            content: "Recovered completion",
            model: "test-model",
          })),
        };
      } else if (settlement === "hanging" && completionAvailable) {
        return new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) {
            reject(
              new DOMException("Reader recovery request aborted", "AbortError"),
            );
            return;
          }
          request.signal.addEventListener(
            "abort",
            () => {
              reject(
                new DOMException(
                  "Reader recovery request aborted",
                  "AbortError",
                ),
              );
            },
            { once: true },
          );
        });
      }
      return Response.json({ items: [row], nextCursor: null, limit: 50 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    reads: () => listRequests,
    deletions: () => deletions,
    releaseRecovery: () => {
      completionAvailable = true;
    },
  };
};

test("persisted streaming answers poll to completion and release mutations", async () => {
  const server = pollingServer("complete");
  const { wrapper } = setup();
  const hook = renderHook(
    () =>
      useReaderAnswers({ decisionId: "decision-1", generationMode: "enabled" }),
    { wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.answers.at(0)?.messages.at(-1)?.status).toBe(
      "streaming",
    ),
  );
  const pendingReads = server.reads();
  server.releaseRecovery();
  await waitFor(() =>
    expect(hook.result.current.answers.at(0)?.messages.at(-1)?.content).toBe(
      "Recovered completion",
    ),
  );
  const completedReads = server.reads();
  expect(completedReads).toBeGreaterThan(pendingReads);
  await act(async () => {
    await sleep(50);
  });
  expect(server.reads()).toBe(completedReads);
  await act(async () => {
    await hook.result.current.remove("answer-1");
  });
  expect(server.deletions()).toBe(1);
  expect(hook.result.current.answers).toEqual([]);
});

// oxlint-disable-next-line require-contract-domains/require-contract-domains -- These are test server behaviors, not API domain values.
test.each(["never", "hanging"] as const)(
  "persisted claims stop polling at timeout when the server is %s",
  async (settlement) => {
    const server = pollingServer(settlement);
    const { wrapper } = setup();
    const hook = renderHook(
      () =>
        useReaderAnswers({
          decisionId: "decision-1",
          generationMode: "enabled",
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.answers.at(0)?.messages.at(-1)?.status).toBe(
        "streaming",
      ),
    );
    server.releaseRecovery();
    await waitFor(
      () =>
        expect(
          hook.result.current.answers.at(0)?.messages.at(-1),
        ).toMatchObject({
          status: "failed",
          errorCode: "timeout",
        }),
      { timeout: 7000 },
    );
    const settledReads = server.reads();
    await act(async () => {
      await sleep(50);
    });
    expect(server.reads()).toBe(settledReads);
    expect(
      readerAnswerErrorCodeKind(
        hook.result.current.answers.at(0)?.messages.at(-1)?.errorCode ?? null,
      ),
    ).toBe("timeout");
    expect(hook.result.current.failureNotices).toContainEqual(
      expect.objectContaining({
        type: "message",
        messageId: hook.result.current.answers.at(0)?.messages.at(-1)?.id,
        error: expect.objectContaining({ code: "timeout" }),
      }),
    );
    await act(async () => {
      await hook.result.current.remove("answer-1");
    });
    expect(server.deletions()).toBe(1);
  },
  10_000,
);

// oxlint-disable-next-line require-contract-domains/require-contract-domains -- These are fake recovery HTTP outcomes, not API domain values.
test.each([
  "complete",
  "streaming",
  "unavailable",
  "concurrent-completion",
] as const)(
  "reopening an expired cached claim reconciles the server outcome %s before timing out",
  async (outcome) => {
    // oxlint-disable-next-line no-restricted-properties -- The fixture owns the claim clock at the HTTP recovery boundary.
    const expiredAt = Temporal.Now.instant()
      .subtract({ milliseconds: READER_ANSWER_DEADLINE_MS + 1000 })
      .toString();
    const cached = {
      id: toSafeId<"legalReaderAnswer">("answer-1"),
      decisionId: toSafeId<"caseLawDecision">("decision-1"),
      authorId: toSafeId<"user">(user.id),
      mine: true,
      kind: "explain",
      anchor,
      visibility: "private",
      createdAt: expiredAt,
      updatedAt: expiredAt,
      messages: [
        {
          id: toSafeId<"legalReaderAnswerMessage">("expired-assistant"),
          role: "assistant",
          content: "Cached partial",
          citations: [],
          status: "streaming",
          errorCode: null,
          invalidCitationCount: 0,
          model: null,
          usage: null,
          createdAt: expiredAt,
          updatedAt: expiredAt,
        },
      ],
    } satisfies ReaderAnswer;
    const { client, wrapper } = setup();
    const { queryKey } = readerAnswersOptions({
      decisionId: "decision-1",
      organizationId: user.activeOrganizationId,
      userId: user.id,
    });
    client.setQueryData(queryKey, [cached]);
    let reads = 0;
    let authoritativeReads = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.method).toBe("GET");
        reads += 1;
        // Cross the zero-timeout boundary, just as an actual HTTP request must.
        await sleep(20, { signal: request.signal });
        authoritativeReads += 1;
        if (outcome === "concurrent-completion") {
          client.setQueryData(queryKey, [
            {
              ...cached,
              messages: cached.messages.map((message) => ({
                ...message,
                status: "complete",
                content: "Saved completion",
              })),
            } satisfies ReaderAnswer,
          ]);
        }
        if (outcome === "unavailable" || outcome === "concurrent-completion") {
          return Response.json(
            { message: "Recovery unavailable" },
            { status: 503 },
          );
        }
        const answer = {
          ...cached,
          messages: cached.messages.map((message) => ({
            ...message,
            status: outcome,
            content:
              outcome === "complete" ? "Saved completion" : message.content,
          })),
        } satisfies ReaderAnswer;
        return Response.json({ items: [answer], nextCursor: null, limit: 50 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const hook = renderHook(
      () =>
        useReaderAnswers({
          decisionId: "decision-1",
          generationMode: "enabled",
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.answers.at(0)?.messages.at(-1)).toMatchObject(
        outcome === "complete" || outcome === "concurrent-completion"
          ? { status: "complete", content: "Saved completion", errorCode: null }
          : {
              status: "failed",
              content: "Cached partial",
              errorCode: "timeout",
            },
      ),
    );
    expect(authoritativeReads).toBeGreaterThan(0);
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );
    const settledReads = reads;
    await act(async () => {
      await sleep(50);
    });
    expect(reads).toBe(settledReads);
  },
);

test("a dropped reader GET is a request failure and keeps its cause", async () => {
  const dropped = new TypeError("Dropped connection");
  globalThis.fetch = Object.assign(
    async () => {
      throw dropped;
    },
    { preconnect: originalFetch.preconnect },
  );
  const { client } = setup();
  expect(
    await rejectionOf(
      client.query(
        readerAnswersOptions({
          decisionId: "decision-1",
          organizationId: user.activeOrganizationId,
          userId: user.id,
        }),
      ),
    ),
  ).toMatchObject({ kind: "request", cause: dropped });
});

test("a non-network reader GET rejection retains the original error", async () => {
  const misuse = new RangeError("Programmer invariant");
  globalThis.fetch = Object.assign(
    async () => {
      throw misuse;
    },
    { preconnect: originalFetch.preconnect },
  );
  const { client } = setup();
  expect(
    await rejectionOf(
      client.query(
        readerAnswersOptions({
          decisionId: "decision-1",
          organizationId: user.activeOrganizationId,
          userId: user.id,
        }),
      ),
    ),
  ).toBe(misuse);
});

test("a reader GET API response is unwrapped outside the network conversion", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json(
        {
          message: "Unavailable",
        },
        { status: 503 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  const { client } = setup();
  expect(
    await rejectionOf(
      client.query(
        readerAnswersOptions({
          decisionId: "decision-1",
          organizationId: user.activeOrganizationId,
          userId: user.id,
        }),
      ),
    ),
  ).toMatchObject({ status: 503 });
});
