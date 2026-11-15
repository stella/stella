import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import type { LocalRunQuestionPause } from "@stll/api-contract/chat-local-run-question";
import type { ChatLocalRunQuestion } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

// The network, for this file: the thread-page test below answers the page's
// requests itself. Installed before the app loads, so a client that keeps a
// reference to `fetch` keeps this one.
const originalFetch = globalThis.fetch;
let routeRequest:
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) =>
    routeRequest === undefined
      ? Response.json({ message: "No server" }, { status: 503 })
      : await routeRequest(input, init),
  { preconnect: () => undefined },
);

const { act, createRef, useImperativeHandle } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { LocalRunQuestionCard } =
  await import("@/components/chat/local-run-question-card");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { invalidateChatThread } = await import("@/features/chat/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatEditorProvider, useChatEditor } =
  await import("@/components/chat-editor-provider");
const { PromptEditorContent } = await import("@/components/prompt-editor");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

afterEach(async () => {
  await act(async () => cleanup());
  routeRequest = undefined;
  __resetChatRequestStateForTests();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const governingLaw = {
  id: "law",
  header: "Governing law",
  prompt: "Which law governs the lease?",
  options: [
    { label: "Czech", description: "Czech Civil Code" },
    { label: "Slovak", description: "Slovak Civil Code" },
  ],
  allowsFreeText: false,
  multiSelect: false,
  secret: false,
} as const satisfies ChatLocalRunQuestion;
const signatories = {
  id: "parties",
  header: "Signatories",
  prompt: "Who signs?",
  options: [
    { label: "Lessor", description: "" },
    { label: "Lessee", description: "" },
  ],
  allowsFreeText: true,
  multiSelect: true,
  secret: false,
} as const satisfies ChatLocalRunQuestion;
const passphrase = {
  id: "passphrase",
  header: "Passphrase",
  prompt: "The archive passphrase?",
  options: [],
  allowsFreeText: true,
  multiSelect: false,
  secret: true,
} as const satisfies ChatLocalRunQuestion;

const INTERRUPT_ID = "00000000-0000-7000-8000-0000000000a1";
const pause: LocalRunQuestionPause = {
  interruptId: INTERRUPT_ID,
  questions: [governingLaw, signatories, passphrase],
};

const THREAD = {
  scope: "global",
  threadId: toChatThreadId("00000000-0000-7000-8000-0000000000d1"),
} as const satisfies ChatThreadRef;
const DRAFT_KEY = getChatThreadKey(THREAD);

/** The thread's composer, on screen beside the card. */
const Composer = ({ ref }: { ref: Ref<ChatEditorController> }) => {
  const controller = useChatEditor({ threadRef: THREAD });
  useImperativeHandle(ref, () => controller, [controller]);
  return <PromptEditorContent editor={controller.editor} />;
};

const mountCard = (
  delivery: "sent" | "not_sent" = "sent",
  composer: "none" | "live" = "none",
) => {
  const answers: { interruptId: string; answers: unknown }[] = [];
  const live = createRef<ChatEditorController>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (card: "shown" | "gone") => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <ChatThreadTestRouter>
            <ChatEditorProvider>
              {card === "shown" && (
                <LocalRunQuestionCard
                  threadRef={THREAD}
                  onAnswer={async (interruptId, given) => {
                    answers.push({ interruptId, answers: given });
                    await Promise.resolve();
                    return delivery;
                  }}
                  pause={pause}
                />
              )}
              {composer === "live" && <Composer ref={live} />}
            </ChatEditorProvider>
          </ChatThreadTestRouter>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(tree("shown"));
  const closeCard = async () => {
    await act(async () => {
      view.rerender(tree("gone"));
    });
  };
  return { answers, view, live, closeCard };
};

const button = (name: string) => screen.getByRole("button", { name });
const submitButton = () => button(messages.chat.askUser.submit);
const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") ||
  element.getAttribute("aria-disabled") === "true";

describe("local run question card", () => {
  test("shows each question with its options, its own-words field and a masked secret field", () => {
    const { view } = mountCard();
    for (const question of pause.questions) {
      expect(screen.getByText(question.header)).not.toBeNull();
      expect(screen.getByText(question.prompt)).not.toBeNull();
    }
    for (const label of ["Czech", "Slovak", "Lessor", "Lessee"]) {
      expect(button(label).getAttribute("aria-pressed")).toBe("false");
    }
    // Several may be picked only where the question says so.
    expect(
      screen.getAllByText(messages.chat.localRunQuestion.chooseSeveral),
    ).toHaveLength(1);
    // Own words are offered only where the agent takes them.
    expect(
      screen.getAllByRole("button", { name: messages.chat.askUser.custom }),
    ).toHaveLength(1);
    const secret = screen.getByLabelText(passphrase.prompt);
    expect(secret.getAttribute("type")).toBe("password");
    expect(view.container.querySelectorAll('input[type="text"]')).toHaveLength(
      0,
    );
  });

  test("offers Submit only once every question is answered as the agent accepts", () => {
    const { answers } = mountCard();
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.click(button("Czech"));
    fireEvent.click(button("Slovak"));
    expect(button("Czech").getAttribute("aria-pressed")).toBe("false");
    expect(button("Slovak").getAttribute("aria-pressed")).toBe("true");
    // The picked option's description shows beside it.
    expect(screen.getByText("Slovak Civil Code")).not.toBeNull();
    fireEvent.click(button("Lessor"));
    fireEvent.click(button("Lessee"));
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.change(screen.getByLabelText(passphrase.prompt), {
      target: { value: "open sesame" },
    });
    expect(isDisabled(submitButton())).toBe(false);
    fireEvent.click(submitButton());
    expect(answers).toEqual([
      {
        interruptId: INTERRUPT_ID,
        answers: {
          law: ["Slovak"],
          parties: ["Lessor", "Lessee"],
          passphrase: ["open sesame"],
        },
      },
    ]);
  });

  test("sends own words in place of the options and never shows a secret back", () => {
    const { answers, view } = mountCard();
    fireEvent.click(button("Czech"));
    fireEvent.click(button(messages.chat.askUser.custom));
    fireEvent.change(screen.getByLabelText(signatories.prompt), {
      target: { value: "  Guarantor " },
    });
    fireEvent.change(screen.getByLabelText(passphrase.prompt), {
      target: { value: "open sesame" },
    });
    fireEvent.click(submitButton());
    expect(answers.at(0)?.answers).toEqual({
      law: ["Czech"],
      parties: ["Guarantor"],
      passphrase: ["open sesame"],
    });
    // Sent: the answers show, the secret only as hidden, and nothing is
    // offered twice.
    expect(screen.getByText("Guarantor")).not.toBeNull();
    expect(
      screen.getByText(messages.chat.localRunQuestion.secretAnswer),
    ).not.toBeNull();
    expect(view.container.textContent).not.toContain("open sesame");
    expect(view.container.querySelector("input")).toBeNull();
    expect(
      screen.queryByRole("button", { name: messages.chat.askUser.submit }),
    ).toBeNull();
  });

  test("an answer that did not go out leaves the card usable, not on a spinner", async () => {
    mountCard("not_sent");
    fireEvent.click(button(messages.chat.localRunQuestion.dismiss));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: messages.chat.localRunQuestion.dismiss,
        }) === null,
      ).toBe(false);
    });
  });

  test("own words left unsent go to the composer when the card closes; a secret's never do", async () => {
    useChatDraftStore.setState({ draftsByThreadKey: {} });
    const { view } = mountCard();
    fireEvent.click(button(messages.chat.askUser.custom));
    fireEvent.change(screen.getByLabelText(signatories.prompt), {
      target: { value: "The guarantor signs too" },
    });
    fireEvent.change(screen.getByLabelText(passphrase.prompt), {
      target: { value: "open sesame" },
    });
    // The turn ended without the answer: the card goes.
    await act(async () => {
      view.unmount();
    });
    const draft = JSON.stringify(
      useChatDraftStore.getState().getDraft(DRAFT_KEY)?.doc ?? null,
    );
    expect(draft).toContain("The guarantor signs too");
    expect(draft).not.toContain("open sesame");
  });

  test("own words left unsent follow what the member just typed in the live composer", async () => {
    useChatDraftStore.setState({ draftsByThreadKey: {} });
    const { live, closeCard } = mountCard("sent", "live");
    await waitFor(() => {
      expect(live.current?.editor?.isInitialized).toBe(true);
    });
    const editor = live.current?.editor ?? panic("no live composer");
    fireEvent.click(button(messages.chat.askUser.custom));
    fireEvent.change(screen.getByLabelText(signatories.prompt), {
      target: { value: "The guarantor signs too" },
    });
    // Typed a moment ago: the stored draft has not caught up yet.
    act(() => {
      editor.chain().focus("end").insertContent("Also check clause 4. ").run();
    });
    await closeCard();
    // Its own paragraph, so it never runs into what was typed.
    expect(editor.getText()).toBe(
      "Also check clause 4. \n\nThe guarantor signs too",
    );
  });

  test("dismiss sends no answers", () => {
    const { answers } = mountCard();
    fireEvent.click(button(messages.chat.localRunQuestion.dismiss));
    expect(answers).toEqual([{ interruptId: INTERRUPT_ID, answers: null }]);
    expect(
      screen.queryByRole("button", {
        name: messages.chat.localRunQuestion.dismiss,
      }),
    ).toBeNull();
  });
});

// --- The thread page, reloaded while the turn waits on the question --------

const API_ORIGIN = "http://localhost:3001";
const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const THREAD_ID = "00000000-0000-7000-8000-0000000000b1";
const TURN_ID = "00000000-0000-7000-8000-0000000000b2";
const RUN_ID = "run-local-question";
const QUESTION_CALL_ID = "local:run-1:item_q";

/** The thread as the API stores a turn paused on a local run's question. */
const pausedPage = () => ({
  activeTurnId: TURN_ID,
  lastActivityAt: "2026-01-01T00:00:11.000Z",
  olderCursor: null,
  messages: [
    {
      createdAt: "2026-01-01T00:00:10.000Z",
      edited: false,
      id: "00000000-0000-7000-8000-0000000000c1",
      metadata: {},
      parts: [{ type: "text", content: "Draft the lease" }],
      revision: 0,
      role: "user",
    },
    {
      createdAt: "2026-01-01T00:00:11.000Z",
      edited: false,
      id: "00000000-0000-7000-8000-0000000000c2",
      metadata: {
        resumeSnapshot: {
          resumeState: { runId: RUN_ID, threadId: THREAD_ID },
          pendingInterrupts: [
            {
              id: INTERRUPT_ID,
              reason: "user_input",
              message: governingLaw.prompt,
              toolCallId: QUESTION_CALL_ID,
              metadata: {
                kind: "question",
                toolName: "request_user_input",
                questions: [governingLaw],
              },
            },
          ],
        },
      },
      parts: [
        { type: "text", content: "One thing first." },
        {
          arguments: "{}",
          id: QUESTION_CALL_ID,
          input: {},
          name: "request_user_input",
          state: "input-complete",
          type: "tool-call",
        },
      ],
      revision: 0,
      role: "assistant",
    },
  ],
});

/** The events a chat request streams back, given the run id it names. */
type ChatAnswer = (runId: unknown) => Record<string, unknown>[];

const settledRun: ChatAnswer = (runId) => [
  { type: "RUN_STARTED", runId, threadId: THREAD_ID, timestamp: 1 },
  {
    type: "RUN_FINISHED",
    runId,
    threadId: THREAD_ID,
    finishReason: "stop",
    timestamp: 2,
  },
];

const EMPTY_PAGE = {
  activeTurnId: null,
  lastActivityAt: null,
  olderCursor: null,
  messages: [],
};

type ThreadPage = ReturnType<typeof pausedPage> | typeof EMPTY_PAGE;

const serveThread = ({
  page: firstPage = pausedPage(),
  answers = [],
}: {
  page?: ThreadPage;
  answers?: ChatAnswer[];
} = {}) => {
  const posted: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  /** How often the page asked the server where the paused turn stands. */
  const turnReads: string[] = [];
  let page = firstPage;
  let revision = 1;
  routeRequest = async (input, init) => {
    await Promise.resolve();
    const request = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? request?.method ?? "GET";
    if (url.origin !== API_ORIGIN) {
      unexpected.push(`${method} ${url.href}`);
      return Response.json({}, { status: 404 });
    }
    if (
      method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/messages`
    ) {
      return Response.json({
        ...page,
        attachedFiles: { fileCount: 0, files: [] },
        context: null,
        contextMatterIds: [],
        forkProvenance: { type: "none" },
        model: null,
        reasoningEffort: null,
        threadRevision: `revision-${String(revision)}`,
        activeSkill: null,
        threadExists: page.messages.length > 0,
        usedAnonymization: false,
        webSearchAvailable: false,
        webSearchEnabled: false,
      });
    }
    if (
      method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/turns/${TURN_ID}/resume`
    ) {
      turnReads.push(url.pathname);
      return Response.json({
        type: "transcript",
        turnId: TURN_ID,
        resumeSnapshot: pausedPage().messages[1]?.metadata.resumeSnapshot,
      });
    }
    if (method === "POST" && url.pathname === "/v1/chat") {
      const text =
        typeof init?.body === "string" ? init.body : await request?.text();
      const body: unknown = JSON.parse(text ?? "null");
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return panic("The page posted a chat request without a JSON body");
      }
      posted.push(Object.fromEntries(Object.entries(body)));
      const runId: unknown = Reflect.get(body, "runId");
      const events = (answers[posted.length - 1] ?? settledRun)(runId);
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            [CHAT_TURN_ID_HEADER]: TURN_ID,
          },
        },
      );
    }
    unexpected.push(`${method} ${url.pathname}`);
    return Response.json({ message: "Not served" }, { status: 404 });
  };
  return {
    posted,
    unexpected,
    turnReads,
    /** The server stores a new state of the thread for the next read. */
    store: (next: ThreadPage) => {
      page = next;
      revision += 1;
    },
  };
};

/** A run on the member's computer that asks its question and pauses. */
const askingRun: ChatAnswer = (runId) => [
  { type: "RUN_STARTED", runId, threadId: THREAD_ID, timestamp: 1 },
  {
    type: "TEXT_MESSAGE_START",
    messageId: "msg-local",
    role: "assistant",
    timestamp: 2,
  },
  {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "msg-local",
    delta: "One thing first.",
    timestamp: 3,
  },
  { type: "TEXT_MESSAGE_END", messageId: "msg-local", timestamp: 4 },
  {
    type: "TOOL_CALL_START",
    toolCallId: QUESTION_CALL_ID,
    toolCallName: "request_user_input",
    toolName: "request_user_input",
    timestamp: 5,
  },
  {
    type: "TOOL_CALL_ARGS",
    toolCallId: QUESTION_CALL_ID,
    delta: "{}",
    timestamp: 6,
  },
  {
    type: "TOOL_CALL_END",
    toolCallId: QUESTION_CALL_ID,
    toolCallName: "request_user_input",
    toolName: "request_user_input",
    input: {},
    timestamp: 7,
  },
  {
    type: "RUN_FINISHED",
    runId,
    threadId: THREAD_ID,
    finishReason: "tool_calls",
    timestamp: 8,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: INTERRUPT_ID,
          reason: "user_input",
          message: governingLaw.prompt,
          toolCallId: QUESTION_CALL_ID,
          metadata: {
            kind: "question",
            toolName: "request_user_input",
            questions: [governingLaw],
          },
        },
      ],
    },
  },
];

const resumeOf = (body: Record<string, unknown>): unknown => body["resume"];

/** The question card the page shows for the paused interrupt. */
const questionCard = async (container: HTMLElement): Promise<HTMLElement> =>
  await waitFor(() => {
    const card = container.querySelector(
      `[data-local-run-question="${INTERRUPT_ID}"]`,
    );
    return card instanceof HTMLElement
      ? card
      : panic("The question card is not shown");
  });

describe("a turn paused on a local run's question", () => {
  test("shows the question again after a reload and answers that interrupt", async () => {
    const server = serveThread();
    const { view } = await openChatThreadDomPage({
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
    });
    const card = await questionCard(view.container);
    fireEvent.click(within(card).getByRole("button", { name: "Czech" }));
    fireEvent.click(
      within(card).getByRole("button", { name: messages.chat.askUser.submit }),
    );
    await waitFor(() => {
      if (server.posted.length === 0) {
        panic("The answer is not sent yet");
      }
    });
    expect(server.posted.map(resumeOf)).toEqual([
      [
        {
          interruptId: INTERRUPT_ID,
          payload: { answers: { law: ["Czech"] } },
          status: "resolved",
        },
      ],
    ]);
    expect(server.unexpected).toEqual([]);
  });

  test("shows the question as the run asks it, and answers that interrupt", async () => {
    const server = serveThread({ page: EMPTY_PAGE, answers: [askingRun] });
    const live = await openChatThreadDomPage({
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
    });
    let sent: Promise<void> | undefined;
    await act(async () => {
      sent = live.session().sendMessage({
        content: "Draft the lease",
        id: toSafeId<"chatMessage">("00000000-0000-7000-8000-0000000000c1"),
      });
      await Promise.resolve();
    });
    const card = await questionCard(live.view.container);
    fireEvent.click(within(card).getByRole("button", { name: "Slovak" }));
    fireEvent.click(
      within(card).getByRole("button", { name: messages.chat.askUser.submit }),
    );
    await waitFor(() => {
      if (server.posted.length < 2) {
        panic("The answer is not sent yet");
      }
    });
    expect(server.posted.map(resumeOf)).toEqual([
      undefined,
      [
        {
          interruptId: INTERRUPT_ID,
          payload: { answers: { law: ["Slovak"] } },
          status: "resolved",
        },
      ],
    ]);
    await sent;
    expect(server.unexpected).toEqual([]);
  });

  test("keeps what the member picked when the thread is read again after the pause", async () => {
    const server = serveThread({ page: EMPTY_PAGE, answers: [askingRun] });
    const live = await openChatThreadDomPage({
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
    });
    let sent: Promise<void> | undefined;
    await act(async () => {
      sent = live.session().sendMessage({
        content: "Draft the lease",
        id: toSafeId<"chatMessage">("00000000-0000-7000-8000-0000000000c1"),
      });
      await Promise.resolve();
    });
    const card = await questionCard(live.view.container);
    await sent;
    fireEvent.click(within(card).getByRole("button", { name: "Slovak" }));

    // The read that follows the pause lands after the pick, with the paused
    // turn as the server stored it.
    server.store(pausedPage());
    await act(async () => {
      await invalidateChatThread({
        queryClient: live.queryClient,
        threadRef: { scope: "global", threadId: toChatThreadId(THREAD_ID) },
      });
    });

    // The same card, not a fresh one: the pick is still on it.
    expect(await questionCard(live.view.container)).toBe(card);
    expect(
      within(card)
        .getByRole("button", { name: "Slovak" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const submit = within(card).getByRole("button", {
      name: messages.chat.askUser.submit,
    });
    expect(isDisabled(submit)).toBe(false);
    // The paused turn was not read from the server again.
    expect(server.turnReads).toEqual([]);
    fireEvent.click(submit);
    await waitFor(() => {
      if (server.posted.length < 2) {
        panic("The answer is not sent yet");
      }
    });
    expect(resumeOf(server.posted.at(1) ?? {})).toEqual([
      {
        interruptId: INTERRUPT_ID,
        payload: { answers: { law: ["Slovak"] } },
        status: "resolved",
      },
    ]);
    expect(server.unexpected).toEqual([]);
  });

  test("dismissing it resumes the interrupt cancelled", async () => {
    const server = serveThread();
    const { view } = await openChatThreadDomPage({
      organizationId: ORGANIZATION_ID,
      threadId: THREAD_ID,
    });
    const card = await questionCard(view.container);
    fireEvent.click(
      within(card).getByRole("button", {
        name: messages.chat.localRunQuestion.dismiss,
      }),
    );
    await waitFor(() => {
      if (server.posted.length === 0) {
        panic("The dismissal is not sent yet");
      }
    });
    expect(server.posted.map(resumeOf)).toEqual([
      [{ interruptId: INTERRUPT_ID, status: "cancelled" }],
    ]);
  });
});
