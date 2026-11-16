import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  createChatPastedTextPart,
  isChatPastedTextPart,
} from "@stll/api-contract/chat";
import {
  CHAT_QUEUE_HOLD_REASONS,
  CHAT_QUEUE_PREVIEW_MAX_CHARS,
  CHAT_SEND_QUEUES_INSTEAD_CODE,
} from "@stll/api-contract/chat-queue";
import {
  CHAT_TURN_STEERING,
  type ChatThreadSendState,
} from "@stll/api-contract/chat-send-intent";
import { DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH } from "@stll/api-contract/desktop-runner";

import type { ChatQueue, ChatQueueItem } from "@/features/chat/chat-queue";
import {
  canQueueMessage,
  CHAT_QUEUE_HOLD_NOTICE_KEYS,
  composerDraftOfParts,
  isQueueInsteadRefusal,
  queuedSendNow,
  queueMoveTarget,
  snapshotChatRequestOptions,
  steerableMessageText,
  steerableQueuedText,
  withQueuedMessageMoved,
  withQueuedMessageRemoved,
} from "@/features/chat/chat-queue.logic";
import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const item = (
  id: string,
  overrides: Partial<ChatQueueItem> = {},
): ChatQueueItem => ({
  attachmentCount: 0,
  createdAt: "2026-11-15T10:00:00.000Z",
  id: toSafeId<"chatMessage">(id),
  position: 1,
  preview: `Message ${id}`,
  revision: 0,
  runTarget: null,
  sendMode: CHAT_SEND_MODE.rawOverride,
  ...overrides,
});

const queueOf = (...ids: string[]): ChatQueue => ({
  hold: null,
  items: ids.map((id, index) => item(id, { position: index + 1 })),
});

const STATES = {
  idle: { type: "idle" },
  workingSteerable: {
    type: "working",
    steering: CHAT_TURN_STEERING.steerable,
  },
  workingNotSteerable: {
    type: "working",
    steering: CHAT_TURN_STEERING.notSteerable,
  },
  waitingSteerable: {
    type: "waiting_on_member",
    steering: CHAT_TURN_STEERING.steerable,
  },
  waitingNotSteerable: {
    type: "waiting_on_member",
    steering: CHAT_TURN_STEERING.notSteerable,
  },
} as const satisfies Record<string, ChatThreadSendState>;

describe("the queue line", () => {
  test("names every reason the server holds a queue for", () => {
    expect(Object.keys(CHAT_QUEUE_HOLD_NOTICE_KEYS).toSorted()).toEqual(
      [...CHAT_QUEUE_HOLD_REASONS].toSorted(),
    );
  });
});

describe("Send now on a queued message", () => {
  test("never ends what a turn waits on without the member's confirmation", () => {
    for (const state of [STATES.waitingSteerable, STATES.waitingNotSteerable]) {
      expect(queuedSendNow(state, item("a"))).toEqual({ type: "replace" });
    }
  });

  test("hands a turn that takes messages mid-turn a message of raw text, however long its preview", () => {
    for (const queued of [
      item("a"),
      // The preview is cut at its limit; the turn is handed the message read
      // whole (`steerableQueuedText`).
      item("long", { preview: "x".repeat(CHAT_QUEUE_PREVIEW_MAX_CHARS) }),
    ]) {
      expect(queuedSendNow(STATES.workingSteerable, queued)).toEqual({
        type: "steer",
      });
    }
  });

  test("sends a message the turn cannot take as the next one, stopping the turn", () => {
    const notSteerable = [
      item("files", { attachmentCount: 1 }),
      item("anonymized", { sendMode: CHAT_SEND_MODE.anonymized }),
      item("empty", { preview: "  " }),
    ];
    for (const queued of notSteerable) {
      expect(queuedSendNow(STATES.workingSteerable, queued)).toEqual({
        type: "send",
      });
    }
    expect(queuedSendNow(STATES.workingNotSteerable, item("a"))).toEqual({
      type: "send",
    });
    expect(queuedSendNow(STATES.idle, item("a"))).toEqual({ type: "send" });
  });
});

describe("moving a queued message", () => {
  const ids = ["a", "b", "c"];
  const items = ids.map((id) => item(id));

  test("goes one place up or down, and nowhere past either end", () => {
    expect(queueMoveTarget({ direction: "up", id: "a", items })).toBe(
      undefined,
    );
    expect(queueMoveTarget({ direction: "up", id: "b", items })).toEqual({
      beforeId: "a",
    });
    expect(queueMoveTarget({ direction: "down", id: "a", items })).toEqual({
      beforeId: "c",
    });
    expect(queueMoveTarget({ direction: "down", id: "b", items })).toEqual({
      beforeId: null,
    });
    expect(queueMoveTarget({ direction: "down", id: "c", items })).toBe(
      undefined,
    );
  });

  test("shows the order the server writes, positions 1..n", () => {
    const movedOrder = (id: string, direction: "down" | "up") => {
      const target = queueMoveTarget({ direction, id, items });
      return target === undefined
        ? undefined
        : withQueuedMessageMoved({
            beforeId: target.beforeId,
            id,
            queue: queueOf(...ids),
          }).items.map((queued) => `${queued.id}${String(queued.position)}`);
    };
    expect(movedOrder("b", "up")).toEqual(["b1", "a2", "c3"]);
    expect(movedOrder("c", "up")).toEqual(["a1", "c2", "b3"]);
    expect(movedOrder("a", "down")).toEqual(["b1", "a2", "c3"]);
    expect(movedOrder("b", "down")).toEqual(["a1", "c2", "b3"]);
  });
});

describe("removing a queued message", () => {
  test("keeps the rest in order, and the hold only while something is queued", () => {
    const held: ChatQueue = {
      ...queueOf("a", "b"),
      hold: {
        queuedMessageId: null,
        reason: "member",
        refusalCode: null,
        turnId: null,
      },
    };
    const one = withQueuedMessageRemoved({ id: "a", queue: held });
    expect(
      one.items.map(({ id, position }) => `${id}${String(position)}`),
    ).toEqual(["b1"]);
    expect(one.hold).toEqual(held.hold);
    expect(withQueuedMessageRemoved({ id: "b", queue: one })).toEqual({
      hold: null,
      items: [],
    });
  });
});

describe("what a message brings to the queue", () => {
  test("text and pasted text can wait; a file the composer has not stored cannot", () => {
    const id = toSafeId<"chatMessage">("message");
    expect(canQueueMessage({ content: "<p>Hello</p>", id })).toBe(true);
    expect(
      canQueueMessage({
        content: [
          { type: "text", content: "<p>See</p>" },
          createChatPastedTextPart("pasted"),
        ],
        id,
      }),
    ).toBe(true);
    expect(
      canQueueMessage({
        content: [
          { type: "text", content: "<p>See</p>" },
          {
            type: "image",
            source: {
              type: "url",
              value: "data:image/png;base64,AAAA",
              mimeType: "image/png",
            },
          },
        ],
        id,
      }),
    ).toBe(false);
  });

  test("a queued message read whole goes to a running turn whole, up to what a steer takes", () => {
    const raw = { sendMode: CHAT_SEND_MODE.rawOverride };
    const long = "Clause ".repeat(CHAT_QUEUE_PREVIEW_MAX_CHARS);
    expect(long.length).toBeGreaterThan(CHAT_QUEUE_PREVIEW_MAX_CHARS);
    expect(
      steerableQueuedText({
        item: raw,
        parts: [{ type: "text", content: long }],
      }),
    ).toBe(long.trim());
    const tooLong = "x".repeat(DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH + 1);
    expect(
      steerableQueuedText({
        item: raw,
        parts: [{ type: "text", content: tooLong }],
      }),
    ).toBeNull();
    expect(
      steerableQueuedText({
        item: raw,
        parts: [
          { type: "text", content: "Go" },
          createChatPastedTextPart("pasted"),
        ],
      }),
    ).toBeNull();
    expect(
      steerableQueuedText({
        item: { sendMode: CHAT_SEND_MODE.anonymized },
        parts: [{ type: "text", content: "Go" }],
      }),
    ).toBeNull();
    expect(
      steerableQueuedText({
        item: raw,
        parts: [
          { type: "text", content: "Go" },
          {
            type: "file",
            url: "stella-user-file://f",
            mimeType: "application/pdf",
          },
        ],
      }),
    ).toBeNull();
  });

  test("a running turn takes raw text alone", () => {
    const id = toSafeId<"chatMessage">("message");
    expect(
      steerableMessageText({ content: " <p>Go</p> ", id }, undefined),
    ).toBe("<p>Go</p>");
    expect(
      steerableMessageText(
        { content: "<p>Go</p>", id },
        { body: { sendMode: CHAT_SEND_MODE.anonymized } },
      ),
    ).toBeNull();
    expect(
      steerableMessageText(
        {
          content: [
            { type: "text", content: "<p>Go</p>" },
            createChatPastedTextPart("pasted"),
          ],
          id,
        },
        undefined,
      ),
    ).toBeNull();
  });

  test("goes back into the composer as its markup and its pasted texts", () => {
    const pasted = createChatPastedTextPart("a long paste");
    // The fixture reaches the split: a pasted text is a text part too.
    expect(isChatPastedTextPart(pasted)).toBe(true);
    expect(pasted.type).toBe("text");
    expect(
      composerDraftOfParts([
        { type: "text", content: "<p>One</p>" },
        pasted,
        { type: "image", source: { type: "url", value: "user-file://x" } },
      ]),
    ).toEqual({ html: "<p>One</p>", pastedTexts: ["a long paste"] });
  });
});

describe("a refused send", () => {
  test("is queued on every code the server refuses a new message with for the queue's sake", () => {
    for (const code of Object.values(CHAT_SEND_QUEUES_INSTEAD_CODE)) {
      const refusal = new Error("refused", {
        cause: new APIError({ code, message: "Refused", status: 409 }),
      });
      expect(isQueueInsteadRefusal(refusal)).toBe(true);
    }
    expect(
      isQueueInsteadRefusal(
        new APIError({
          code: "chat_edit_turn_running",
          message: "No",
          status: 409,
        }),
      ),
    ).toBe(false);
  });
});

describe("the options a message is queued with", () => {
  test("keep the send mode and edit preferences of the moment it was queued", () => {
    expect(
      snapshotChatRequestOptions({
        docxEditRepresentation: "direct",
        editApplyMode: "auto",
        options: undefined,
        sendMode: CHAT_SEND_MODE.anonymized,
      }),
    ).toEqual({
      body: {
        docxEditRepresentation: "direct",
        editApplyMode: "auto",
        sendMode: CHAT_SEND_MODE.anonymized,
      },
    });
    expect(
      snapshotChatRequestOptions({
        docxEditRepresentation: undefined,
        editApplyMode: undefined,
        options: undefined,
        sendMode: undefined,
      }),
    ).toBeUndefined();
  });
});
