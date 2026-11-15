import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import {
  CHAT_QUEUE_HOLD_REASONS,
  type ChatQueueHoldReason,
} from "@stll/api-contract/chat-queue";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatEditorController } from "@/components/chat-editor-provider";

// The chat's queue on the thread page, through the page's own wiring (the
// session hook, the queue read and the transcript's queue list) over a fake
// server that keeps the queue: each action on a queued message reaches its
// route, and the list shows what the server then answers.

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

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

const { act, cleanup, fireEvent, waitFor, within } =
  await import("@testing-library/react");
const { default: messages } = await import("@/i18n/langs/en.json");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { chatKeys } = await import("@/features/chat/chat-query-contract");
const { useChatEditor } = await import("@/components/chat-editor-provider");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { EditorContent } = await import("@tiptap/react");
const { useExternalSyncEffect } = await import("@/hooks/use-effect");

const actEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
beforeAll(() => {
  // The server answers on its own schedule, not inside a test's `act()`.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});
afterEach(async () => {
  await act(async () => cleanup());
  routeRequest = undefined;
  __resetChatRequestStateForTests();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const API_ORIGIN = "http://localhost:3001";
const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const THREAD_ID = "00000000-0000-7000-8000-0000000000d1";
/** The member `openChatThreadDomPage` signs in as. */
const USER_ID = "00000000-0000-7000-8000-00000000fffe";
const QUEUE_PATH = `/v1/chat/threads/${THREAD_ID}/queue`;
const FIRST = "00000000-0000-7000-8000-0000000000e1";
const SECOND = "00000000-0000-7000-8000-0000000000e2";
const THIRD = "00000000-0000-7000-8000-0000000000e3";
const TEXTS: Record<string, string> = {
  [FIRST]: "Add a break clause",
  [SECOND]: "Then shorten the notice period",
  [THIRD]: "And check the deposit",
};
const textOf = (id: string) => TEXTS[id] ?? panic(`No text for ${id}`);

const QUESTION_INPUT = {
  analysis: "The draft depends on the side the member represents.",
  questions: [{ question: "Which side?", reason: "It decides the draft." }],
};

/** The thread as stored: the last turn asks the member a question, so the
 *  turn waits on them. `waiting` false: the turn answered and ended. */
const storedThread = (waiting: boolean) => [
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
    metadata: waiting ? {} : { turnOutcome: { type: "completed" } },
    parts: waiting
      ? [
          {
            arguments: JSON.stringify(QUESTION_INPUT),
            id: "ask",
            input: QUESTION_INPUT,
            name: "ask-user",
            state: "input-complete",
            type: "tool-call",
          },
        ]
      : [{ type: "text", content: "Here is the draft." }],
    revision: 0,
    role: "assistant",
  },
];

type Hold = {
  queuedMessageId: string | null;
  reason: ChatQueueHoldReason;
  refusalCode: string | null;
  turnId: string | null;
};

const holdOf = (reason: ChatQueueHoldReason): Hold => {
  switch (reason) {
    case "member":
    case "usage-limit":
    case "computer-away":
      return { queuedMessageId: null, reason, refusalCode: null, turnId: null };
    case "turn-failed":
    case "turn-interrupted":
      return {
        queuedMessageId: null,
        reason,
        refusalCode: null,
        turnId: "00000000-0000-7000-8000-0000000000f1",
      };
    case "send-refused":
      return {
        queuedMessageId: FIRST,
        reason,
        refusalCode: "send_refused",
        turnId: null,
      };
    default:
      reason satisfies never;
      return panic("Unhandled hold reason");
  }
};

/**
 * The API with a queue of `FIRST`, `SECOND`, `THIRD`. Each queue route does
 * to the queue what the server does, and every request the page makes is
 * recorded as `METHOD path` with its JSON body.
 */
type Server = {
  hold: Hold | null;
  order: string[];
  requests: string[];
  unexpected: string[];
};

/** The `beforeId` a move request names. */
const beforeIdOf = (body: string): string | null => {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("beforeId" in parsed)
  ) {
    return panic("A move without beforeId");
  }
  const { beforeId } = parsed;
  return typeof beforeId === "string" ? beforeId : null;
};

const serve = ({ waiting }: { waiting: boolean }) => {
  const state: Server = {
    hold: null,
    order: [FIRST, SECOND, THIRD],
    requests: [],
    unexpected: [],
  };
  routeRequest = async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const { method } = request;
    const route = `${method} ${url.pathname}`;
    if (url.origin !== API_ORIGIN) {
      state.unexpected.push(`${method} ${url.href}`);
      return Response.json({}, { status: 404 });
    }
    if (
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
        lastActivityAt: "2026-01-01T00:00:11.000Z",
        messages: storedThread(waiting),
        model: null,
        olderCursor: null,
        reasoningEffort: null,
        threadExists: true,
        threadRevision: "revision-1",
        usedAnonymization: false,
        webSearchAvailable: false,
        webSearchEnabled: false,
      });
    }
    if (method === "GET" && url.pathname === QUEUE_PATH) {
      return Response.json({
        hold: state.hold,
        items: state.order.map((id, index) => ({
          attachmentCount: 0,
          createdAt: "2026-01-01T00:00:12.000Z",
          id,
          position: index + 1,
          preview: textOf(id),
          revision: 0,
          runTarget: null,
          sendMode: "raw-override",
        })),
      });
    }
    if (!url.pathname.startsWith(QUEUE_PATH)) {
      state.unexpected.push(route);
      return Response.json({ message: "Not served" }, { status: 404 });
    }
    const body = method === "GET" ? "" : await request.text();
    state.requests.push(body === "" ? route : `${route} ${body}`);
    const [id, action] = url.pathname.slice(QUEUE_PATH.length + 1).split("/");
    if (id === "hold") {
      state.hold = method === "PUT" ? holdOf("member") : null;
      return Response.json({});
    }
    if (id === undefined || !state.order.includes(id)) {
      state.unexpected.push(route);
      return Response.json({ message: "Not queued" }, { status: 404 });
    }
    const without = state.order.filter((queued) => queued !== id);
    if (method === "DELETE") {
      state.order = without;
      return Response.json({
        message: {
          id,
          role: "user",
          parts: [{ type: "text", content: textOf(id) }],
        },
      });
    }
    switch (action) {
      case "move": {
        const beforeId = beforeIdOf(body);
        const at =
          beforeId === null ? without.length : without.indexOf(beforeId);
        state.order = [...without.slice(0, at), id, ...without.slice(at)];
        return Response.json({});
      }
      case "send-now":
        state.order = [id, ...without];
        state.hold = null;
        return Response.json({});
      default:
        state.unexpected.push(route);
        return Response.json({ message: "Not served" }, { status: 404 });
    }
  };
  return state;
};

const COMPOSER_THREAD_REF = {
  scope: "global",
  threadId: toChatThreadId(THREAD_ID),
} as const;

/** The thread's main composer, as the page mounts it. */
const Composer = ({
  onController,
}: {
  onController: (controller: ChatEditorController) => void;
}) => {
  const controller = useChatEditor({ threadRef: COMPOSER_THREAD_REF });
  useExternalSyncEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return <EditorContent editor={controller.editor} />;
};

const openPage = async () => {
  let composer: ChatEditorController | undefined;
  const page = await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    renderComposer: () => (
      <Composer
        onController={(controller) => {
          composer = controller;
        }}
      />
    ),
    threadId: THREAD_ID,
  });
  const view = within(page.view.container);
  await waitFor(() => {
    if (view.queryByText(textOf(THIRD)) === null) {
      panic("The queue is not shown yet");
    }
  });
  return {
    composerText: () =>
      (composer?.editor ?? panic("The composer has no editor")).getText(),
    page,
    view,
  };
};

/** The queued messages' texts as the list shows them, in order. */
const shownOrder = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="entity-actions"]')]
    .filter(
      (bubble) =>
        bubble instanceof HTMLElement &&
        within(bubble).queryByRole("button", {
          name: messages.chat.queue.actions,
        }) !== null,
    )
    .map((bubble) => bubble.textContent);

const menuItems = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
    item.textContent.trim(),
  );

/** Opens the "…" menu of the queued message with `text` and clicks `label`. */
const chooseAction = async (
  view: ReturnType<typeof within>,
  text: string,
  label: string,
) => {
  const bubble =
    view.getByText(text).closest('[data-slot="entity-actions"]') ??
    panic(`No actions around ${text}`);
  fireEvent.click(
    within(bubble).getByRole("button", { name: messages.chat.queue.actions }),
  );
  const item = await waitFor(
    () =>
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent.trim() === label,
      ) ?? panic(`No "${label}" in ${JSON.stringify(menuItems())}`),
  );
  fireEvent.click(item);
};

/** The line above the queue that says whether and why it waits. */
const noticeText = (view: ReturnType<typeof within>) => {
  const control =
    view.queryByRole("button", { name: messages.chat.queue.pause }) ??
    view.getByRole("button", { name: messages.chat.queue.resume });
  return (
    control.parentElement?.querySelector('[role="status"]')?.textContent ??
    panic("No queue notice")
  );
};

test("Send now over a turn that waits on the member asks first, and sends the message only once confirmed", async () => {
  const server = serve({ waiting: true });
  const { page, view } = await openPage();
  // The confirmation opens over the page, outside its container.
  const body = within(document.body);
  const sendNowOf = (text: string) =>
    within(
      view.getByText(text).closest('[data-slot="entity-actions"]') ??
        panic(`No actions around ${text}`),
    ).getByRole("button", { name: messages.chat.sendQueuedMessageNow });

  fireEvent.click(sendNowOf(textOf(SECOND)));
  const dialog = await waitFor(() => body.getByRole("alertdialog"));
  expect(
    within(dialog).getByText(messages.chat.queue.replaceTitle),
  ).toBeDefined();
  // Cancelled: nothing reaches the server, the queue stays as it was.
  fireEvent.click(
    within(dialog).getByRole("button", { name: messages.common.cancel }),
  );
  await waitFor(() => {
    if (body.queryByRole("alertdialog") !== null) {
      panic("The confirmation is still open");
    }
  });
  expect(server.requests).toEqual([]);

  fireEvent.click(sendNowOf(textOf(SECOND)));
  const again = await waitFor(() => body.getByRole("alertdialog"));
  fireEvent.click(
    within(again).getByRole("button", {
      name: messages.chat.sendQueuedMessageNow,
    }),
  );
  await waitFor(() => {
    expect(shownOrder(page.view.container)).toEqual([
      textOf(SECOND),
      textOf(FIRST),
      textOf(THIRD),
    ]);
  });
  expect(server.requests).toEqual([`POST ${QUEUE_PATH}/${SECOND}/send-now`]);
  expect(server.unexpected).toEqual([]);
});

test("Send now on a chat whose turn has ended sends the message next without asking", async () => {
  const server = serve({ waiting: false });
  const { view } = await openPage();

  await chooseAction(view, textOf(THIRD), messages.chat.sendQueuedMessageNow);

  await waitFor(() => {
    expect(server.requests).toEqual([`POST ${QUEUE_PATH}/${THIRD}/send-now`]);
  });
  expect(within(document.body).queryByRole("alertdialog")).toBeNull();
  expect(server.unexpected).toEqual([]);
});

test("Move, Remove and Edit change the server's queue, and Edit hands the message to the composer", async () => {
  const server = serve({ waiting: true });
  const { composerText, page, view } = await openPage();

  // The first message cannot move up, the last one cannot move down.
  await chooseAction(view, textOf(SECOND), messages.common.moveUp);
  await waitFor(() => {
    expect(shownOrder(page.view.container)).toEqual([
      textOf(SECOND),
      textOf(FIRST),
      textOf(THIRD),
    ]);
  });
  expect(server.requests).toEqual([
    `POST ${QUEUE_PATH}/${SECOND}/move {"beforeId":"${FIRST}"}`,
  ]);
  fireEvent.click(
    within(
      view.getByText(textOf(SECOND)).closest('[data-slot="entity-actions"]') ??
        panic("No actions"),
    ).getByRole("button", { name: messages.chat.queue.actions }),
  );
  await waitFor(() => {
    expect(menuItems()).toContain(messages.common.moveDown);
  });
  expect(menuItems()).not.toContain(messages.common.moveUp);
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => {
    expect(menuItems()).toEqual([]);
  });

  await chooseAction(view, textOf(THIRD), messages.chat.cancelQueuedMessage);
  await waitFor(() => {
    expect(shownOrder(page.view.container)).toEqual([
      textOf(SECOND),
      textOf(FIRST),
    ]);
  });
  expect(server.requests.at(-1)).toBe(`DELETE ${QUEUE_PATH}/${THIRD}`);

  await chooseAction(view, textOf(FIRST), messages.common.edit);
  await waitFor(() => {
    expect(composerText()).toBe(textOf(FIRST));
  });
  await waitFor(() => {
    expect(shownOrder(page.view.container)).toEqual([textOf(SECOND)]);
  });
  expect(server.requests.at(-1)).toBe(`DELETE ${QUEUE_PATH}/${FIRST}`);
  expect(server.order).toEqual([SECOND]);
  expect(server.unexpected).toEqual([]);
});

const HOLD_NOTICES = {
  "turn-failed": messages.chat.queue.heldTurnFailed,
  "turn-interrupted": messages.chat.queue.heldTurnInterrupted,
  member: messages.chat.queue.heldByMember,
  "send-refused": messages.chat.queue.heldSendRefused,
  "usage-limit": messages.chat.queue.heldUsageLimit,
  "computer-away": messages.chat.queue.heldComputerAway,
} as const satisfies Record<ChatQueueHoldReason, string>;

test("Pause holds the queue and Resume releases it; the list says what holds it, for every reason", async () => {
  const server = serve({ waiting: false });
  const { page, view } = await openPage();
  expect(noticeText(view)).toBe(messages.chat.queuedNotice);

  fireEvent.click(
    view.getByRole("button", { name: messages.chat.queue.pause }),
  );
  await waitFor(() => {
    expect(noticeText(view)).toBe(messages.chat.queue.heldByMember);
  });
  expect(server.requests).toEqual([`PUT ${QUEUE_PATH}/hold`]);

  fireEvent.click(
    view.getByRole("button", { name: messages.chat.queue.resume }),
  );
  await waitFor(() => {
    expect(noticeText(view)).toBe(messages.chat.queuedNotice);
  });
  expect(server.requests).toEqual([
    `PUT ${QUEUE_PATH}/hold`,
    `DELETE ${QUEUE_PATH}/hold`,
  ]);

  // Whatever holds it, the list names the reason and offers Resume; a
  // refused send also marks the message that was refused.
  for (const reason of CHAT_QUEUE_HOLD_REASONS) {
    const notice = HOLD_NOTICES[reason];
    server.hold = holdOf(reason);
    await page.queryClient.invalidateQueries({
      queryKey: chatKeys.queue(ORGANIZATION_ID, USER_ID, THREAD_ID),
    });
    await waitFor(() => {
      expect(noticeText(view)).toBe(notice);
    });
    expect(
      view.getByRole("button", { name: messages.chat.queue.resume }),
    ).toBeDefined();
    expect(view.queryAllByText(messages.chat.queue.notSent)).toHaveLength(
      reason === "send-refused" ? 1 : 0,
    );
  }
  expect(server.unexpected).toEqual([]);
});
