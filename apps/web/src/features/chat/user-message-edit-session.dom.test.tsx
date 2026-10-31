import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import {
  CHAT_MESSAGE_EDIT_ERROR_CODE,
  CHAT_TURN_ID_HEADER,
  CHAT_TURN_INTENT,
} from "@stll/api-contract";
import { sleep } from "@stll/concurrency/sleep";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import { PASTED_TEXT_CHIP_MAX_LINES } from "@/components/chat-pasted-text";
import translations from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// Editing a sent message on the thread page, through the page's own wiring:
// the session hook, the runtime registry, the chat runtime and the edit form,
// over a fake server where the network is. Each refusal the server can send,
// and a lost connection, must leave the form open on the user's draft over
// the thread as the server stores it; an open form holds queued prompts.

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const originalFetch = globalThis.fetch;
let routeRequest:
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (routeRequest === undefined) {
      return Response.json({ message: "No server" }, { status: 503 });
    }
    return await routeRequest(input, init);
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { toSafeId } = await import("@/lib/safe-id");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { invalidateChatThread } = await import("@/features/chat/queries");
const { useChatEditor } = await import("@/components/chat-editor-provider");
const { composerText } = await import("@/components/chat-editor-source");
const { EditorContent } = await import("@tiptap/react");
const { useExternalSyncEffect } = await import("@/hooks/use-effect");
const { stellaToast } = await import("@stll/ui/toast");
const { PASTED_TEXT_ATTACHMENTS_ATTR, readPastedTextAttachments } =
  await import("@/components/chat-pasted-text-extension");

const actEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
beforeAll(() => {
  // The server answers on its own schedule, not inside a test's `act()`.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

afterEach(() => {
  testing.cleanup();
  routeRequest = undefined;
  __resetChatRequestStateForTests();
});

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const API_ORIGIN = "http://localhost:3001";
const THREAD_ID = "00000000-0000-7000-8000-00000000c0de";
const TURN_ID = "00000000-0000-7000-8000-0000000000b1";
const FIRST = "00000000-0000-7000-8000-0000000000a1";
const SECOND = "00000000-0000-7000-8000-0000000000a2";
const THIRD = "00000000-0000-7000-8000-0000000000a3";
const QUEUED = "00000000-0000-7000-8000-0000000000a9";

/** A file a stored message carries, as the server stores it. */
type StoredFile = {
  filename: string;
  id: string;
  kind: "document" | "image";
  mimeType: string;
};

type StoredMessage = {
  files?: readonly StoredFile[] | undefined;
  id: string;
  role: "assistant" | "user";
  text: string;
};

const turnOf = (id: string, question: string): StoredMessage[] => [
  { id, role: "user", text: question },
  {
    id: `${id.slice(0, -2)}f${id.slice(-1)}`,
    role: "assistant",
    text: "Answer",
  },
];

/** Two answered questions, as the server stores the thread. */
const STORED: readonly StoredMessage[] = [
  ...turnOf(FIRST, "First question"),
  ...turnOf(SECOND, "Second question"),
];

const serialize = (messages: readonly StoredMessage[]) =>
  messages.map(({ files = [], id, role, text }, index) => ({
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString(),
    id,
    parts: [
      { content: text, type: "text" },
      ...files.map((file) => ({
        metadata: { filename: file.filename },
        source: {
          mimeType: file.mimeType,
          type: "url",
          value: `/v1/user-files/${file.id}`,
        },
        type: file.kind,
      })),
    ],
    role,
  }));

/** The thread once the server ran the edit of the second question. */
const STORED_AFTER_EDIT: readonly StoredMessage[] = [
  ...turnOf(FIRST, "First question"),
  { id: SECOND, role: "user", text: "Second question again" },
  { id: "reply", role: "assistant", text: "Edited answer" },
];

/** What the server answers a send: a refusal, a lost connection, or a
 *  short accepted turn, which it then stores as `STORED_AFTER_EDIT`. */
type SendAnswer =
  | { type: "accepted" }
  | { type: "refused"; code: string; status: number }
  | { type: "connection-lost" };

const acceptedTurn = (runId: string): Response => {
  const events = [
    { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
    { messageId: "reply", role: "assistant", type: "TEXT_MESSAGE_START" },
    {
      delta: "Edited answer",
      messageId: "reply",
      type: "TEXT_MESSAGE_CONTENT",
    },
    { messageId: "reply", type: "TEXT_MESSAGE_END" },
    { finishReason: "stop", runId, threadId: THREAD_ID, type: "RUN_FINISHED" },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: {
        [CHAT_TURN_ID_HEADER]: TURN_ID,
        "Content-Type": "text/event-stream",
      },
    },
  );
};

/**
 * The thread's server. `stored` is the thread as the server holds it; a
 * refusal may change it first (`storedAfterRefusal`), as another turn would.
 * With `answerAfter`, a send is answered only once it settles.
 */
const createServer = ({
  answer,
  answerAfter,
  initial = STORED,
  storedAfterRefusal,
}: {
  answer: SendAnswer;
  answerAfter?: Promise<unknown> | undefined;
  initial?: readonly StoredMessage[] | undefined;
  storedAfterRefusal?: readonly StoredMessage[] | undefined;
}) => {
  let stored = initial;
  const posted: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (url.origin === API_ORIGIN && url.pathname === "/v1/chat") {
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      );
      if (typeof body !== "object" || body === null) {
        return panic("Expected a JSON chat request");
      }
      posted.push(Object.fromEntries(Object.entries(body)));
      await answerAfter;
      switch (answer.type) {
        case "accepted": {
          stored = STORED_AFTER_EDIT;
          const runId: unknown = Reflect.get(body, "runId");
          return acceptedTurn(typeof runId === "string" ? runId : "run-edit");
        }
        case "refused":
          stored = storedAfterRefusal ?? stored;
          return Response.json(
            { code: answer.code, message: "Refused" },
            { status: answer.status },
          );
        case "connection-lost":
          throw new TypeError("Failed to fetch");
      }
    }
    if (
      url.origin === API_ORIGIN &&
      method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/messages`
    ) {
      return Response.json({
        activeSkill: null,
        activeTurnId: null,
        attachedFiles: { fileCount: 0, files: [] },
        context: null,
        contextMatterIds: [],
        forkProvenance: { type: "none" },
        lastActivityAt: null,
        messages: serialize(stored),
        model: null,
        olderCursor: null,
        reasoningEffort: null,
        threadExists: true,
        threadRevision: `revision-${String(stored.length)}`,
        usedAnonymization: false,
        webSearchAvailable: false,
        webSearchEnabled: false,
      });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return Response.json({ message: "Not served" }, { status: 404 });
  };
  return {
    fetch,
    posted,
    /** Another tab or device changed the thread: the server now stores
     *  `messages`. */
    replaceStored: (messages: readonly StoredMessage[]) => {
      stored = messages;
    },
    unexpected,
  };
};

type Page = Awaited<ReturnType<typeof openChatThreadDomPage>>;

const COMPOSER_THREAD_REF = {
  scope: "global",
  threadId: toChatThreadId(THREAD_ID),
} as const;

/** The thread's main composer, as the page mounts it; `onController` hears
 *  its controller each time it changes. */
const Composer = ({
  onController,
}: {
  onController: (controller: ChatEditorController) => void;
}) => {
  const controller = useChatEditor({ threadRef: COMPOSER_THREAD_REF });
  useExternalSyncEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return (
    <div data-test-composer>
      <EditorContent editor={controller.editor} />
    </div>
  );
};

const openPage = async (
  server: ReturnType<typeof createServer>,
  onComposer?: (controller: ChatEditorController) => void,
) => {
  routeRequest = server.fetch;
  return await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    renderComposer:
      onComposer === undefined
        ? undefined
        : () => <Composer onController={onComposer} />,
    threadId: THREAD_ID,
  });
};

/** The page's messages as id, role and text, in order. */
const shownMessages = (page: Page): StoredMessage[] =>
  page.session().messages.map(({ id, parts, role }) => ({
    id,
    role: role === "user" ? "user" : "assistant",
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join(""),
  }));

/** The open edit form's field. Read by selector, not by role: a role query
 *  walks the whole transcript, and polling it starves the page it waits on. */
const editField = (page: Page) =>
  page.view.container.querySelector<HTMLElement>(
    `[data-chat-message-edit] [role=textbox][aria-label="${translations.chat.editMessageInput}"]`,
  );

/** Opens the edit form of the second question and adds to its text. */
const editSecondQuestion = async (page: Page) => {
  const pencils = await testing
    .within(page.view.container)
    .findAllByRole("button", { name: translations.chat.editMessage });
  const pencil = pencils.at(1) ?? panic("The second question's edit action");
  testing.fireEvent.click(pencil);
  const field = editField(page) ?? panic("The edit form");
  testing.fireEvent.paste(field, {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? " again" : ""),
      items: [],
      types: ["text/plain"],
    },
  });
  expect(field.textContent).toBe("Second question again");
};

const sendEdit = (page: Page) => {
  testing.fireEvent.click(
    testing
      .within(page.view.container)
      .getByRole("button", { name: translations.chat.sendPrompt }),
  );
};

const editNotice = async (page: Page) =>
  await testing.waitFor(
    () =>
      page.view.container.querySelector("[data-chat-message-edit] [role=alert]")
        ?.textContent ?? panic("No edit notice yet"),
  );

describe("an edit the server does not accept", () => {
  const REFUSALS = [
    {
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning,
      notice: translations.chat.editMessageRefused,
      status: 409,
    },
    {
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged,
      notice: translations.chat.editMessageRefusedHistoryChanged,
      status: 409,
    },
    {
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
      notice: translations.chat.editMessageRefusedTargetMissing,
      status: 404,
    },
    {
      code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage,
      notice: translations.chat.editMessageRefusedTargetMissing,
      status: 409,
    },
    {
      code: "unauthorized",
      notice: translations.errors.api.unauthorized,
      status: 401,
    },
    {
      code: "validation_failed",
      notice: translations.errors.api.validation,
      status: 422,
    },
  ] as const;

  for (const { code, notice, status } of REFUSALS) {
    test(`refused as ${code}: the form keeps the draft over the stored thread`, async () => {
      // A changed history (another turn landed) or an unchanged one: either
      // way the page shows what the server stores, not its truncated view.
      const storedAfterRefusal =
        code === CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged
          ? [...STORED, ...turnOf(THIRD, "Third")]
          : STORED;
      const server = createServer({
        answer: { type: "refused", code, status },
        storedAfterRefusal,
      });
      const page = await openPage(server);
      await editSecondQuestion(page);

      sendEdit(page);

      expect(await editNotice(page)).toBe(notice);
      await testing.waitFor(() => {
        expect(shownMessages(page)).toEqual([...storedAfterRefusal]);
      });
      expect(editField(page)?.textContent).toBe("Second question again");
      expect(page.session().error).toBeUndefined();
      expect(server.posted).toHaveLength(1);
      expect(server.posted.at(0)?.["forwardedProps"]).toMatchObject({
        truncateAfterMessageId: SECOND,
        turnIntent: CHAT_TURN_INTENT.edit,
      });
      expect(server.unexpected).toEqual([]);
    });
  }

  test("a lost connection keeps the draft over the stored thread", async () => {
    const server = createServer({ answer: { type: "connection-lost" } });
    const page = await openPage(server);
    await editSecondQuestion(page);

    sendEdit(page);

    expect(await editNotice(page)).toBe(
      translations.chat.sendErrorConnectionFailed,
    );
    await testing.waitFor(() => {
      expect(shownMessages(page)).toEqual([...STORED]);
    });
    expect(editField(page)?.textContent).toBe("Second question again");
    expect(server.unexpected).toEqual([]);
  });
});

describe("an edit whose message the server no longer holds", () => {
  // Another edit dropped the second turn: the stored thread ends after the
  // first, and the refused edit's form goes with its message.
  const STORED_WITHOUT_SECOND = turnOf(FIRST, "First question");
  const LONG_PASTE = Array.from(
    { length: PASTED_TEXT_CHIP_MAX_LINES + 1 },
    (_, line) => `Clause ${String(line + 1)}`,
  ).join("\n");

  let composerController: ChatEditorController | undefined;
  const composer = () =>
    composerController ?? panic("The thread's composer is not mounted");
  const composerEditor = () =>
    composer().editor ?? panic("The composer has no editor");
  const composerParagraphs = () =>
    composerEditor().state.doc.content.content.map((node) => node.textContent);
  const composerPastedTexts = () =>
    readPastedTextAttachments(
      composerEditor().state.doc.attrs[PASTED_TEXT_ATTACHMENTS_ATTR],
    ).map(({ text }) => text);

  /** Opens the second question's edit, adds a word and a long paste that
   *  becomes a pasted-text chip, and sends it into a target_missing
   *  refusal; `prepareComposer` runs on the mounted composer first. */
  const sendOrphanedEdit = async (
    prepareComposer: () => void,
    initial: readonly StoredMessage[] = STORED,
  ): Promise<unknown> => {
    const warning = spyOn(stellaToast, "warning").mockReturnValue("notice");
    const server = createServer({
      answer: {
        type: "refused",
        code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
        status: 404,
      },
      initial,
      storedAfterRefusal: STORED_WITHOUT_SECOND,
    });
    const page = await openPage(server, (controller) => {
      composerController = controller;
    });
    await testing.waitFor(() => {
      expect(
        composerController !== undefined && composerController.editor !== null,
      ).toBe(true);
    });
    prepareComposer();
    await editSecondQuestion(page);
    const field = editField(page) ?? panic("The edit form");
    testing.fireEvent.paste(field, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? LONG_PASTE : ""),
        items: [],
        types: ["text/plain"],
      },
    });
    sendEdit(page);
    await testing.waitFor(() => {
      expect(shownMessages(page)).toEqual([...STORED_WITHOUT_SECOND]);
    });
    await testing.waitFor(() => {
      expect(warning).toHaveBeenCalledTimes(1);
    });
    expect(editField(page) === null).toBe(true);
    const [notice] = warning.mock.calls[0] ?? panic("No notice");
    return notice;
  };

  afterEach(() => {
    composerController = undefined;
    // The composer's draft outlives the page; each test starts from none.
    useChatDraftStore
      .getState()
      .clearDraft(getChatThreadKey(COMPOSER_THREAD_REF));
    mock.restore();
  });

  test("goes into the empty composer with its text and chips, and says why", async () => {
    const notice = await sendOrphanedEdit(() => undefined);

    expect(notice).toBe(translations.chat.editMessageRefusedTargetMissing);
    await testing.waitFor(() => {
      expect(composerParagraphs()).toEqual(["Second question again"]);
    });
    expect(composerPastedTexts()).toEqual([LONG_PASTE]);
  });

  test("names every kept document and image it could not bring back", async () => {
    // The second question carried a stored document and image, and the
    // edit kept both. The composer holds only files picked on this device,
    // so neither can follow the text: the notice names each by file name.
    const files: readonly StoredFile[] = [
      {
        filename: "nda.pdf",
        id: "00000000-0000-7000-8000-0000000000d1",
        kind: "document",
        mimeType: "application/pdf",
      },
      {
        filename: "scan.png",
        id: "00000000-0000-7000-8000-0000000000d2",
        kind: "image",
        mimeType: "image/png",
      },
    ];
    const notice = await sendOrphanedEdit(
      () => undefined,
      STORED.map((message) =>
        message.id === SECOND ? { ...message, files } : message,
      ),
    );

    const [before, after] =
      translations.chat.editMessageRefusedTargetMissingFiles.split("{files}");
    expect(typeof notice).toBe("string");
    const text = typeof notice === "string" ? notice : "";
    expect(text.startsWith(before ?? panic("Notice text"))).toBe(true);
    expect(text.endsWith(after ?? panic("Notice text"))).toBe(true);
    expect(text).toContain("nda.pdf");
    expect(text).toContain("scan.png");
    await testing.waitFor(() => {
      expect(composerParagraphs()).toEqual(["Second question again"]);
    });
    expect(composerPastedTexts()).toEqual([LONG_PASTE]);
  });

  test("goes ahead of what the composer already holds, a paragraph between", async () => {
    await sendOrphanedEdit(() => {
      composer().setContent(composerText("Draft already here"));
    });

    await testing.waitFor(() => {
      expect(composerParagraphs()).toEqual([
        "Second question again",
        "",
        "Draft already here",
      ]);
    });
    expect(composerPastedTexts()).toEqual([LONG_PASTE]);
  });

  describe("a late answer to a cancelled edit", () => {
    /** Sends an edit the server answers only on `answered`, cancels it while
     *  the answer is out, and opens the same message again with a new
     *  draft. */
    const cancelAndReopen = async (
      page: Page,
      server: ReturnType<typeof createServer>,
    ) => {
      await editSecondQuestion(page);
      sendEdit(page);
      // The edit is out: the server holds its answer.
      await testing.waitFor(() => {
        expect(server.posted).toHaveLength(1);
      });
      testing.fireEvent.click(
        testing
          .within(page.view.container)
          .getByRole("button", { name: translations.common.cancel }),
      );
      await testing.waitFor(() => {
        expect(editField(page) === null).toBe(true);
      });
      const pencils = await testing
        .within(page.view.container)
        .findAllByRole("button", { name: translations.chat.editMessage });
      testing.fireEvent.click(
        pencils.at(1) ?? panic("The second question's edit action"),
      );
      const field = editField(page) ?? panic("The reopened edit form");
      testing.fireEvent.paste(field, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? " later" : ""),
          items: [],
          types: ["text/plain"],
        },
      });
      expect(field.textContent).toBe("Second question again later");
    };

    test("an accepted answer leaves the newer edit open on its draft", async () => {
      const answered = Promise.withResolvers<undefined>();
      const server = createServer({
        answer: { type: "accepted" },
        answerAfter: answered.promise,
      });
      const page = await openPage(server);
      await cancelAndReopen(page, server);
      expect(server.posted).toHaveLength(1);

      answered.resolve(undefined);

      await testing.waitFor(() => {
        expect(
          shownMessages(page).some(({ id }) => id === "reply") &&
            !page.session().isGenerating,
        ).toBe(true);
      });
      expect(editField(page)?.textContent).toBe("Second question again later");
    });

    test("a target-missing answer hands over the newer draft once, not the cancelled one", async () => {
      const warning = spyOn(stellaToast, "warning").mockReturnValue("notice");
      const answered = Promise.withResolvers<undefined>();
      const server = createServer({
        answer: {
          type: "refused",
          code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
          status: 404,
        },
        answerAfter: answered.promise,
        storedAfterRefusal: STORED_WITHOUT_SECOND,
      });
      const page = await openPage(server, (controller) => {
        composerController = controller;
      });
      await cancelAndReopen(page, server);

      answered.resolve(undefined);

      // The thread is reloaded from the server, without the message: the
      // open, newer edit goes into the composer. The cancelled one, whose
      // answer this is, hands nothing over.
      await testing.waitFor(() => {
        expect(shownMessages(page)).toEqual([...STORED_WITHOUT_SECOND]);
      });
      await testing.waitFor(() => {
        expect(composerParagraphs()).toEqual(["Second question again later"]);
      });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        translations.chat.editMessageRefusedTargetMissing,
      );
      expect(composerPastedTexts()).toEqual([]);
    });
  });

  test("an open edit whose message a live reload removes goes into the composer", async () => {
    const warning = spyOn(stellaToast, "warning").mockReturnValue("notice");
    const server = createServer({ answer: { type: "accepted" } });
    const page = await openPage(server, (controller) => {
      composerController = controller;
    });
    await testing.waitFor(() => {
      expect(
        composerController !== undefined && composerController.editor !== null,
      ).toBe(true);
    });
    // An unsent draft is open on the second question.
    await editSecondQuestion(page);

    // Another tab's edit of the first question dropped the second turn.
    server.replaceStored(STORED_WITHOUT_SECOND);
    await invalidateChatThread({
      queryClient: page.queryClient,
      threadRef: COMPOSER_THREAD_REF,
    });

    await testing.waitFor(() => {
      expect(shownMessages(page)).toEqual([...STORED_WITHOUT_SECOND]);
    });
    await testing.waitFor(() => {
      expect(composerParagraphs()).toEqual(["Second question again"]);
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      translations.chat.editMessageRefusedTargetMissing,
    );
    expect(server.posted).toEqual([]);
  });
});

describe("an accepted edit", () => {
  test("replaces the message and every later turn, and closes the form", async () => {
    const server = createServer({ answer: { type: "accepted" } });
    const page = await openPage(server);
    await editSecondQuestion(page);

    sendEdit(page);

    // Checked as a boolean: a failed matcher on a node formats the whole
    // document on every poll.
    await testing.waitFor(() => {
      expect(editField(page) === null).toBe(true);
    });
    // The edited message under its own id, then the edit's answer, in place
    // of every later turn; the server stores the same.
    await testing.waitFor(() => {
      expect(shownMessages(page).map(({ id, role }) => ({ id, role }))).toEqual(
        STORED_AFTER_EDIT.map(({ id, role }) => ({ id, role })),
      );
    });
    expect(shownMessages(page).find(({ id }) => id === SECOND)?.text).toContain(
      "Second question again",
    );
    expect(server.posted.at(0)?.["forwardedProps"]).toMatchObject({
      message: { id: SECOND, role: "user" },
      truncateAfterMessageId: SECOND,
      turnIntent: CHAT_TURN_INTENT.edit,
    });
    expect(server.unexpected).toEqual([]);
  });
});

describe("queued prompts while an edit is open", () => {
  const queuedPrompt = async (page: Page) => {
    await page.session().sendMessage({
      content: "A queued question",
      id: toSafeId<"chatMessage">(QUEUED),
    });
  };

  test("wait while the form is open and are sent once it closes", async () => {
    const server = createServer({ answer: { type: "accepted" } });
    const page = await openPage(server);
    await editSecondQuestion(page);

    await queuedPrompt(page);
    // real-time: give a send that should not happen the time to start.
    await sleep(50);
    expect(server.posted).toEqual([]);
    expect(page.session().queuedMessages.map(({ text }) => text)).toEqual([
      "A queued question",
    ]);

    testing.fireEvent.click(
      testing
        .within(page.view.container)
        .getByRole("button", { name: translations.common.cancel }),
    );

    await testing.waitFor(() => {
      expect(server.posted).toHaveLength(1);
    });
    expect(server.posted.at(0)?.["forwardedProps"]).toMatchObject({
      message: { id: QUEUED },
    });
    expect(server.posted.at(0)?.["forwardedProps"]).not.toHaveProperty(
      "turnIntent",
    );
  });

  test("wait for the accepted edit's turn, then follow it", async () => {
    const server = createServer({ answer: { type: "accepted" } });
    const page = await openPage(server);
    await editSecondQuestion(page);
    await queuedPrompt(page);

    sendEdit(page);

    await testing.waitFor(() => {
      expect(server.posted).toHaveLength(2);
    });
    expect(
      server.posted.map((body): unknown => {
        const forwarded: unknown = body["forwardedProps"];
        const message: unknown =
          typeof forwarded === "object" && forwarded !== null
            ? Reflect.get(forwarded, "message")
            : undefined;
        const id: unknown =
          typeof message === "object" && message !== null
            ? Reflect.get(message, "id")
            : undefined;
        return id;
      }),
    ).toEqual([SECOND, QUEUED]);
  });
});
