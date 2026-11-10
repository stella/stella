import { EventType, StreamProcessor, uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { browserControlRetainedResultSchema } from "@stll/api-contract/browser-control";
import {
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  isUnsupportedChatPart,
} from "@stll/api-contract/chat";

import {
  decodeStoredChatContent,
  encodeStoredChatContent,
} from "@/api/db/stored-chat-part-codec";
import {
  applyChatPartPersistenceBudget,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  isChatPart,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { clientVisibleStreamChunk } from "@/api/handlers/chat/client-visible-chat-part";
import { clientMessageFromPageRow } from "@/api/handlers/chat/message-page";
import { serializeRevisionSnapshot } from "@/api/handlers/chat/messages/revisions/serialize-revision-snapshot";
import type {
  ChatMessage,
  ChatPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { diffLiveAgainstReload } from "@/api/tests/helpers/chat-live-reload-invariants";
import {
  browsingChild,
  childOutputs,
  childPageId,
  rawPageIds,
  SUBAGENT_PARENT_CALL_ID,
  type SubagentStatus,
} from "@/api/tests/helpers/subagent-part-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// A tool-mode sub-agent part (TanStack `chat({ subagents })`) holds its child
// run's messages. It is stored with each child message encoded as a message's
// own content, read back to the same part, and its child keeps its browser
// pages as the run's status allows: a finished run stores none whole.

const MESSAGE_ID = toSafeId<"chatMessage">(
  "019eb9fa-c91f-7000-9b9c-9365977dda90",
);
const PARENT_CALL_ID = SUBAGENT_PARENT_CALL_ID;

const storeAndReload = (parts: ChatPart[]): ChatMessage =>
  chatMessageFromPersisted({
    content: toPersistedChatMessageContentV3({ data: parts }),
    id: MESSAGE_ID,
    role: "assistant",
  });

/** The pages each status keeps whole: only a run that can still continue
 *  keeps its newest one, on its call and its result part. */
const RAW_PAGES_KEPT = {
  error: [],
  finished: [],
  running: [childPageId("running", 2), childPageId("running", 2)],
  suspended: [childPageId("suspended", 2), childPageId("suspended", 2)],
} as const satisfies Record<SubagentStatus, readonly string[]>;

describe("a sub-agent part's child keeps its pages as its status allows", () => {
  for (const status of Object.keys(RAW_PAGES_KEPT).filter(
    (key): key is SubagentStatus => Object.hasOwn(RAW_PAGES_KEPT, key),
  )) {
    test(`a ${status} child`, () => {
      const child = browsingChild(status, 3);
      // The fixture reaches the fault: every step carries a whole page.
      expect(rawPageIds(child)).toHaveLength(6);

      const reloaded = storeAndReload([child]);

      expect(rawPageIds(reloaded.parts.at(0))).toEqual([
        ...RAW_PAGES_KEPT[status],
      ]);
      for (const { output } of childOutputs(reloaded.parts.at(0))) {
        expect(v.is(browserControlRetainedResultSchema, output)).toBe(true);
      }
    });
  }

  test("a finished browse stores no page text at all", () => {
    const stored = JSON.stringify(
      toPersistedChatMessageContentV3({ data: [browsingChild("finished", 3)] }),
    );

    expect(stored).not.toContain("Stránka");
    expect(stored.length).toBeLessThan(10_000);
  });
});

describe("a sub-agent part stores and reloads as the browser shows it", () => {
  test("a stream snapshot carries what the message stores and reloads", () => {
    const parts: ChatPart[] = [
      { content: "Hledám.", type: "text" },
      browsingChild("finished", 2),
      browsingChild("suspended", 2),
    ];
    // Served page parts ride on the AG-UI assistant message.
    const answer = {
      content: "",
      id: MESSAGE_ID,
      parts,
      role: "assistant" as const,
    };
    const chunk = clientVisibleStreamChunk({
      messages: [answer],
      type: EventType.MESSAGES_SNAPSHOT,
    });
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      return panic("Expected a messages snapshot");
    }
    const streamed = asTestRaw<UIMessage>(chunk.messages.at(0));

    const reloaded = storeAndReload(parts);

    expect(streamed.parts).toEqual(reloaded.parts);
    expect(
      diffLiveAgainstReload({
        live: [streamed],
        reload: [asTestRaw<UIMessage>(reloaded)],
      }),
    ).toEqual([]);
  });

  test("the SDK's wire snapshot of a sub-agent part shows what the message reloads", () => {
    const parts: ChatPart[] = [
      { content: "Hledám.", type: "text" },
      browsingChild("finished", 3),
      browsingChild("suspended", 3),
    ];
    const wire = uiMessagesToWire([
      { id: MESSAGE_ID, parts, role: "assistant" },
    ]);
    const childRows = (messages: readonly object[]) =>
      messages.filter(
        (message) => typeof Reflect.get(message, "subagentRunId") === "string",
      );
    // The fixture reaches the seam: the SDK carries each child as its own
    // tagged rows, every page whole.
    expect(JSON.stringify(childRows(wire))).toContain(
      `Stránka ${childPageId("finished", 0)}`,
    );

    const chunk = clientVisibleStreamChunk({
      messages: wire,
      type: EventType.MESSAGES_SNAPSHOT,
    });
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      return panic("Expected a messages snapshot");
    }
    const streamed = JSON.stringify(childRows(chunk.messages));
    for (const page of [0, 1, 2]) {
      expect(streamed).not.toContain(
        `Stránka ${childPageId("finished", page)}`,
      );
    }
    for (const page of [0, 1]) {
      expect(streamed).not.toContain(
        `Stránka ${childPageId("suspended", page)}`,
      );
    }
    expect(streamed).toContain(`Stránka ${childPageId("suspended", 2)}`);

    // The page folds the snapshot into its messages as the SDK does.
    const processor = new StreamProcessor();
    processor.processChunk(chunk);
    const live = processor.getMessages();
    const reloaded = storeAndReload(parts);
    expect(
      live.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "subagent" ? [part.subagent.id] : [],
        ),
      ),
    ).toEqual(["child-finished", "child-suspended"]);
    expect(
      diffLiveAgainstReload({
        live,
        reload: [asTestRaw<UIMessage>(reloaded)],
      }),
    ).toEqual([]);
  });

  test("the SDK's stream processor builds a part that stores and reloads unchanged", () => {
    const subagentRunId = "child-run-1";
    const chunks = [
      {
        messageId: "answer",
        role: "assistant",
        type: EventType.TEXT_MESSAGE_START,
      },
      {
        delta: "Hledám.",
        messageId: "answer",
        type: EventType.TEXT_MESSAGE_CONTENT,
      },
      { messageId: "answer", type: EventType.TEXT_MESSAGE_END },
      {
        name: "browse",
        parentToolCallId: PARENT_CALL_ID,
        subagentRunId,
        type: EventType.SUBAGENT_STARTED,
      },
      {
        messageId: "child-answer",
        role: "assistant",
        subagentRunId,
        type: EventType.TEXT_MESSAGE_START,
      },
      {
        delta: "Otevírám rejstřík.",
        messageId: "child-answer",
        subagentRunId,
        type: EventType.TEXT_MESSAGE_CONTENT,
      },
      {
        messageId: "child-answer",
        subagentRunId,
        type: EventType.TEXT_MESSAGE_END,
      },
      {
        // The chat stream stamps each call's executor on its start.
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
        parentMessageId: "child-answer",
        subagentRunId,
        toolCallId: "child-call-1",
        toolCallName: "lookup_register",
        type: "TOOL_CALL_START",
      },
      {
        delta: '{"query":"§ 88"}',
        subagentRunId,
        toolCallId: "child-call-1",
        type: EventType.TOOL_CALL_ARGS,
      },
      { subagentRunId, toolCallId: "child-call-1", type: "TOOL_CALL_END" },
      {
        content: '{"found":true}',
        messageId: "child-result-1",
        subagentRunId,
        toolCallId: "child-call-1",
        type: EventType.TOOL_CALL_RESULT,
      },
      { subagentRunId, type: EventType.SUBAGENT_FINISHED },
    ] satisfies StreamChunk[];
    const processor = new StreamProcessor();
    for (const chunk of chunks) {
      processor.processChunk(chunk);
    }
    processor.finalizeStream();
    const live = processor.getMessages();
    const answer = live.at(-1) ?? panic("The stream built no message");
    const subagent = answer.parts.find((part) => part.type === "subagent");
    // The fixture reaches the boundary: the processor built a finished
    // tool-mode part whose child holds the call and its result.
    expect(subagent?.subagent).toMatchObject({
      parentToolCallId: PARENT_CALL_ID,
      status: "finished",
    });
    expect(
      subagent?.subagent.messages.flatMap((message) =>
        message.parts.map((part) => part.type),
      ),
    ).toEqual(expect.arrayContaining(["text", "tool-call", "tool-result"]));

    // As a streamed message is persisted: each part classified, then stored.
    const persisted = answer.parts.map((part) => {
      const decision = classifyChatPartForPersistence(part);
      return decision.type === "persist"
        ? decision.part
        : panic(`The ${decision.partType} part was dropped`);
    });
    const reloaded = storeAndReload(persisted);

    expect(
      diffLiveAgainstReload({
        live: [answer],
        reload: [{ ...asTestRaw<UIMessage>(reloaded), id: answer.id }],
      }),
    ).toEqual([]);
  });

  test("the live/reload comparison sees inside a sub-agent part", () => {
    const shown = browsingChild("finished", 1);
    const changed = browsingChild("finished", 2);
    const message = (part: ChatPart) =>
      asTestRaw<UIMessage>({ id: "answer", parts: [part], role: "assistant" });

    expect(
      diffLiveAgainstReload({
        live: [message(shown)],
        reload: [message(changed)],
      }),
    ).not.toEqual([]);
  });

  test("every part of a message keeps its sub-agent parts, however many", () => {
    const parts = Array.from({ length: 20 }, () =>
      browsingChild("finished", 1),
    );

    expect(applyChatPartPersistenceBudget(parts).parts).toHaveLength(20);
    expect(storeAndReload(parts).parts).toHaveLength(20);
  });
});

describe("only a well-formed tool-mode sub-agent part is stored", () => {
  const { subagent } = browsingChild("finished", 1);
  const withoutParentCall = (() => {
    const { parentToolCallId: _parentToolCallId, ...rest } = subagent;
    return rest;
  })();
  const REFUSED = {
    // Router mode: the child's text would be replayed to the parent model.
    "a router-mode part": { subagent: withoutParentCall, type: "subagent" },
    "a part whose child holds a malformed part": {
      subagent: {
        ...subagent,
        messages: [
          {
            id: "child-answer",
            parts: [{ id: "call", state: "not-a-state", type: "tool-call" }],
            role: "assistant",
          },
        ],
      },
      type: "subagent",
    },
    "a nested router-mode part": {
      subagent: {
        ...subagent,
        messages: [
          {
            id: "child-answer",
            parts: [{ subagent: withoutParentCall, type: "subagent" }],
            role: "assistant",
          },
        ],
      },
      type: "subagent",
    },
    "a failed run without its error": {
      subagent: { ...subagent, status: "error" },
      type: "subagent",
    },
    "a suspended run without its interrupts": {
      subagent: { ...subagent, status: "suspended" },
      type: "subagent",
    },
    "a child message with an unknown role": {
      subagent: {
        ...subagent,
        messages: [{ id: "child", parts: [], role: "tool" }],
      },
      type: "subagent",
    },
  } as const;

  for (const [name, part] of Object.entries(REFUSED)) {
    test(`refuses ${name}`, () => {
      expect(isChatPart(part)).toBe(false);
      expect(() => classifyChatPartForPersistence(part)).toThrow(
        "Cannot persist malformed chat part type: subagent",
      );
      expect(() =>
        toPersistedChatMessageContentV3({ data: [asTestRaw<ChatPart>(part)] }),
      ).toThrow("Cannot persist chat message content with unsupported parts");
    });
  }

  test("accepts the same part with its parent call", () => {
    expect(isChatPart({ subagent, type: "subagent" })).toBe(true);
  });
});

describe("a child part a newer release stored", () => {
  const SENTINEL = "newer-release-secret";
  const childContent = {
    data: [
      { content: "Hotovo.", type: "text" },
      { payload: SENTINEL, type: "later-part" },
    ],
    version: 3,
  };
  const stored = {
    data: [
      {
        subagent: {
          id: "child-1",
          messages: [
            { content: childContent, id: "child-answer", role: "assistant" },
          ],
          name: "browse",
          parentToolCallId: PARENT_CALL_ID,
          status: "finished",
        },
        type: "subagent",
      },
    ],
    version: 3,
  };

  test("is carried, written back as stored and never shown", () => {
    const content = asTestRaw<PersistedChatMessageContentV3>(
      decodeStoredChatContent(stored),
    );
    const message = chatMessageFromPersisted({
      content,
      id: MESSAGE_ID,
      role: "assistant",
    });
    const part = message.parts.at(0);
    if (part?.type !== "subagent") {
      return panic("Expected the subagent part to be read");
    }
    expect(
      part.subagent.messages.at(0)?.parts.some(isUnsupportedChatPart),
    ).toBe(true);

    // Saved again with the child unedited, and with it edited.
    expect(
      encodeStoredChatContent(
        toPersistedChatMessageContentV3({ data: [part] }),
      ),
    ).toEqual(stored);
    const edited: ChatPart = {
      ...part,
      subagent: { ...part.subagent, description: "Edited." },
    };
    const rewritten = encodeStoredChatContent(
      toPersistedChatMessageContentV3({ data: [edited] }),
    );
    expect(JSON.stringify(rewritten)).toContain(SENTINEL);
    expect(
      normalizePersistedChatMessageContent(
        asTestRaw<PersistedChatMessageContentV3>(
          decodeStoredChatContent(rewritten),
        ),
      ).parts,
    ).toEqual([edited]);

    const page = clientMessageFromPageRow(
      {
        content,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        id: MESSAGE_ID,
        role: "assistant",
        revision: 0,
      },
      new Map(),
    );
    expect(JSON.stringify(page)).not.toContain(SENTINEL);
    expect(JSON.stringify(serializeRevisionSnapshot(content))).not.toContain(
      SENTINEL,
    );
  });
});
