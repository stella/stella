import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_ID_HEADER, CHAT_TURN_INTENT } from "@stll/api-contract";
import { createChatPastedTextPart } from "@stll/api-contract/chat";

import type {
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  buildEditedUserMessage,
  createUserMessageEditDraft,
} from "@/components/chat/user-message-edit.logic";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import { planTruncatedReplay } from "@/features/chat/hooks/edit-user-message";
import { snapshotChatRequestOptions } from "@/features/chat/hooks/use-chat-session-send-queue.logic";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

const THREAD_ID = toChatThreadId("thread-edit-user-message");
const TURN_ID = "018f0000-0000-7000-8000-0000000000b1";
const FIRST = "018f0000-0000-7000-8000-0000000000a1";
const SECOND = "018f0000-0000-7000-8000-0000000000a2";
const THIRD = "018f0000-0000-7000-8000-0000000000a3";
const FOURTH = "018f0000-0000-7000-8000-0000000000a4";

const userMessage = (
  id: string,
  parts: ChatPart[] = [{ type: "text", content: `Question ${id}` }],
): PersistedChatMessage => ({ id, parts, role: "user" });

const answer = (id: string): PersistedChatMessage => ({
  id: `answer-${id}`,
  parts: [{ type: "text", content: `Answer ${id}` }],
  role: "assistant",
});

const attachment: ChatPart = {
  metadata: { filename: "nda.pdf" },
  source: {
    mimeType: "application/pdf",
    type: "url",
    value: "/v1/user-files/018f0000-0000-7000-8000-0000000000f1",
  },
  type: "document",
};

/** Three user turns, each answered. */
const threeTurns = (): PersistedChatMessage[] => [
  userMessage(FIRST),
  answer(FIRST),
  userMessage(SECOND, [
    { type: "text", content: "Review the **draft** NDA" },
    attachment,
    createChatPastedTextPart("Clause 4: confidentiality"),
  ]),
  answer(SECOND),
  userMessage(THIRD),
  answer(THIRD),
];

describe("truncating the page for an edited user message", () => {
  test("drops the edited message and every later turn, and names it for the server", () => {
    const plan = planTruncatedReplay(threeTurns(), {
      messageId: SECOND,
      type: "user-message",
    });
    expect(plan?.messages.map(({ id }) => id)).toEqual([
      FIRST,
      `answer-${FIRST}`,
    ]);
    expect(plan?.body).toEqual({
      truncateAfterMessageId: SECOND,
      turnIntent: CHAT_TURN_INTENT.edit,
    });
  });

  test("edits the latest message as well as an older one", () => {
    const plan = planTruncatedReplay(threeTurns(), {
      messageId: THIRD,
      type: "user-message",
    });
    expect(plan?.messages.map(({ id }) => id)).toEqual([
      FIRST,
      `answer-${FIRST}`,
      SECOND,
      `answer-${SECOND}`,
    ]);
  });

  test("leaves the page alone for a message it does not hold or an answer", () => {
    const messages = threeTurns();
    for (const messageId of ["missing", `answer-${SECOND}`]) {
      expect(
        planTruncatedReplay(messages, { messageId, type: "user-message" }),
      ).toBeNull();
    }
  });

  test("an answered ask-user card keeps its answer message, reset to take a new answer", () => {
    const toolCallId = "ask-1";
    const asking: PersistedChatMessage = {
      id: "asking",
      parts: [
        {
          arguments: "{}",
          id: toolCallId,
          name: "ask-user",
          output: { answers: [] },
          state: "complete",
          type: "tool-call",
        },
        { content: "{}", state: "complete", toolCallId, type: "tool-result" },
      ],
      role: "assistant",
    };
    const plan = planTruncatedReplay(
      [userMessage(FIRST), asking, userMessage(SECOND), answer(SECOND)],
      { toolCallId, type: "ask-user-answer" },
    );
    expect(plan?.messages.map(({ id }) => id)).toEqual([FIRST, "asking"]);
    expect(plan?.messages.at(1)?.parts).toEqual([
      {
        arguments: "{}",
        id: toolCallId,
        name: "ask-user",
        state: "input-complete",
        type: "tool-call",
      },
    ]);
    expect(plan?.body).toEqual({ truncateAfterMessageId: "asking" });
    // The page's own history is never rewritten in place.
    expect(asking.parts).toHaveLength(2);
  });
});

type Posted = Record<string, unknown>;

const previousFetch = globalThis.fetch;

/** Answers every send with a short finished turn and records each body. */
const installServer = (): Posted[] => {
  const posted: Posted[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      if (typeof body !== "object" || body === null) {
        throw new TypeError("Expected a JSON request body");
      }
      posted.push(Object.fromEntries(Object.entries(body)));
      const runId = `run-${TURN_ID}`;
      const events = [
        { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
        { messageId: "reply", role: "assistant", type: "TEXT_MESSAGE_START" },
        { delta: "Done", messageId: "reply", type: "TEXT_MESSAGE_CONTENT" },
        { messageId: "reply", type: "TEXT_MESSAGE_END" },
        {
          finishReason: "stop",
          runId,
          threadId: THREAD_ID,
          type: "RUN_FINISHED",
        },
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
    },
    { preconnect: previousFetch.preconnect },
  );
  return posted;
};

describe("the edit request", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("posts the edited message under its id with the edit target, keeping the kept attachments", async () => {
    const posted = installServer();
    const errors: Error[] = [];
    const messages = threeTurns();
    const runtime = createChatRuntime({
      activeTurnId: null,
      context: undefined,
      initialMessages: messages,
      key: { scope: "global", threadId: THREAD_ID },
      onError: (error) => {
        errors.push(error);
      },
      onFinish: () => undefined,
      reloadThread: () => undefined,
    });
    // A turn the page ran itself, as before any edit on an open thread.
    await sendThreadChatMessage(runtime, {
      content: "One more question",
      id: toSafeId<"chatMessage">(FOURTH),
    });

    let nextId = 0;
    const draft = createUserMessageEditDraft(
      messages.at(2) ?? expect.unreachable("The second user message"),
      () => {
        nextId += 1;
        return `attachment-${String(nextId)}`;
      },
    );
    expect(draft.text).toBe("Review the draft NDA");
    const edited = {
      ...draft,
      // The user removes the pasted text and keeps the document.
      attachments: draft.attachments.filter(
        ({ part }) => part.type === "document",
      ),
      text: "Review the signed NDA",
    };

    // What `replayFromTruncation` does: rewind the page, then send with the
    // plan's body.
    const plan =
      planTruncatedReplay(runtime.getSnapshot().messages, {
        messageId: SECOND,
        type: "user-message",
      }) ?? expect.unreachable("The edit plan");
    runtime.setMessages(plan.messages);
    await sendThreadChatMessage(
      runtime,
      buildEditedUserMessage({ draft: edited, messageId: SECOND }),
      snapshotChatRequestOptions({
        docxEditRepresentation: undefined,
        editApplyMode: undefined,
        options: { body: plan.body },
        sendMode: CHAT_SEND_MODE.rawOverride,
      }),
    );
    runtime.leave();

    expect(errors).toEqual([]);
    expect(posted).toHaveLength(2);
    const forwarded = posted.at(1)?.["forwardedProps"];
    expect(forwarded).toMatchObject({
      message: {
        id: SECOND,
        parts: [
          { content: "<p>Review the signed NDA</p>", type: "text" },
          attachment,
        ],
        role: "user",
      },
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: THREAD_ID,
      truncateAfterMessageId: SECOND,
      turnIntent: CHAT_TURN_INTENT.edit,
    });
    expect(
      runtime
        .getSnapshot()
        .messages.filter(({ role }) => role === "user")
        .map(({ id }) => id),
    ).toEqual([FIRST, SECOND]);
  });
});
