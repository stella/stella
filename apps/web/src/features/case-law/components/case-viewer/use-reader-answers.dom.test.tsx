import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { DetachedWindowAPI } from "happy-dom";

import type {
  ReaderAnswerErrorCode,
  ReaderAnswer,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { StrictMode, useRef } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { toSafeId } = await import("@/lib/safe-id");
const { useReaderAnswers } = await import("./use-reader-answers");
const {
  applyReaderAnswerEvent,
  readerAnswerFailureKind,
  readerAnswerErrorCodeKind,
} = await import("./reader-answers.logic");

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
const anchor = {
  paragraphId: "paragraph-1",
  quote: "Selected text",
  startOffset: 0,
  endOffset: 13,
};
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
          <FormattingProvider locale="cs" timeZone="UTC">
            {children}
          </FormattingProvider>
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

test("reader answers create, follow up, regenerate, share, reload and delete through the HTTP boundary", async () => {
  const server = fakeServer();
  const { wrapper } = setup();
  const hook = renderHook(
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
  ).toEqual(["assistant-1", "assistant-3"]);
  await act(async () => {
    await hook.result.current.setVisibility("answer-1", "shared");
  });
  expect(hook.result.current.answers.at(0)?.visibility).toBe("shared");
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
  expect(hook.result.current.errors.get("answer-1")).toMatchObject({
    kind: "model",
  });
  expect(
    hook.result.current.answers.at(0)?.messages.at(-1)?.invalidCitationCount,
  ).toBe(1);
  expect(hook.result.current.busyAnswerIds.size).toBe(0);
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
});

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
    ({ decisionId }) => useReaderAnswers({ decisionId, enabled: true }),
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
      enabled: true,
    });
    return (
      <>
        <article ref={root} style={{ overflow: "visible" }}>
          <p data-anchor={anchor.paragraphId}>{anchor.quote}</p>
        </article>
        <AnnotationToolbar
          activeAnnotation={null}
          activeSpans={[]}
          controller={{
            create: () => undefined,
            remove: () => undefined,
            update: () => undefined,
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
            const span = spans.at(0);
            if (span) {
              void answers.createExplain({
                paragraphId: span.blockAnchorId,
                quote: span.quote,
                startOffset: span.startOffset,
                endOffset: span.endOffset,
              });
            }
          }}
        />
        {answers.answers.map((answer) => (
          <ReaderAnswerCard
            key={answer.id}
            answer={answer}
            active={answers.activeAnswerId === answer.id}
            openRevision={0}
            onOpen={() => answers.setActiveAnswerId(answer.id)}
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
            citationLabel={(citation) => citation.paragraphId}
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
              ocr: false,
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
      locale: "cs",
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
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
    ).toEqual(["durable-user", "pending-assistant"]),
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
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
    readerAnswerFailureKind(hook.result.current.errors.get("answer-1")),
  ).toBe("budget");
  hook.unmount();
  const reload = setup();
  const reloaded = renderHook(
    () => useReaderAnswers({ decisionId: "decision-1", enabled: true }),
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
