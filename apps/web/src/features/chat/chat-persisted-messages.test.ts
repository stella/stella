import { ChatClient } from "@tanstack/ai-client";
import type { ConnectConnectionAdapter, UIMessage } from "@tanstack/ai-client";
import { EventType } from "@tanstack/ai/client";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_FILES_METADATA_KEY } from "@stll/api-contract/chat-run-target";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

import {
  toPersistedChatMessages,
  withCurrentChatMessages,
} from "./chat-persisted-messages";

test("a resumed stream retains history added between the persistence read and SDK hydration", async () => {
  const initialMessages = [
    {
      id: "partial",
      role: "assistant",
      parts: [{ type: "text", content: "Drafting" }],
    },
  ] satisfies PersistedChatMessage[];
  let shownMessages: PersistedChatMessage[] = initialMessages;
  const state = withCurrentChatMessages(
    {
      messages: initialMessages,
      resume: {
        resumeState: { threadId: "hydration-window", runId: "running-turn" },
      },
    },
    () => shownMessages,
  );
  const read = Promise.withResolvers<typeof state>();
  const hydrated = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<undefined>();
  const finishStream = Promise.withResolvers<undefined>();
  const joins: string[] = [];
  const errors: Error[] = [];
  const connection = {
    connect: () =>
      panic("The hydration fixture must only rejoin its running turn"),
    async *joinRun(runId) {
      joins.push(runId);
      await finishStream.promise;
      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId: "hydration-window",
      };
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "partial",
        role: "assistant",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "partial",
        delta: "Drafting the reply",
      };
      yield { type: EventType.TEXT_MESSAGE_END, messageId: "partial" };
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId: "hydration-window",
      };
    },
  } satisfies ConnectConnectionAdapter;
  const client = new ChatClient({
    threadId: "hydration-window",
    initialMessages,
    connection,
    persistence: {
      getItem: async () => await read.promise,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    onHydratingChange: (isHydrating) => {
      if (!isHydrating) {
        hydrated.resolve(undefined);
      }
    },
    onLoadingChange: (isLoading) => {
      if (!isLoading) {
        finished.resolve(undefined);
      }
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  client.attach();
  try {
    read.resolve(state);
    // The persistence result already exists, but its promise continuation has
    // not applied it. A page can prepend older history during this window.
    shownMessages = [
      {
        id: "older",
        role: "user",
        parts: [{ type: "text", content: "An earlier question" }],
      },
      ...shownMessages,
    ];
    expect(shownMessages).not.toBe(initialMessages);
    await hydrated.promise;
    expect(client.getIsLoading()).toBe(true);
    expect(joins).toEqual(["running-turn"]);
    expect(client.getMessages().map(({ id }) => id)).toEqual([
      "older",
      "partial",
    ]);

    finishStream.resolve(undefined);
    await finished.promise;
    expect(client.getIsLoading()).toBe(false);
    expect(client.getMessages().map(({ id }) => id)).toEqual([
      "older",
      "partial",
    ]);
    expect(client.getMessages().at(-1)?.parts).toEqual([
      { type: "text", content: "Drafting the reply" },
    ]);
    expect(errors).toEqual([]);
  } finally {
    finishStream.resolve(undefined);
    client.dispose();
  }
});

describe("a file a local run handed back", () => {
  const url = "stella://file::019a0000-0000-7000-8000-000000000001";
  const file = {
    url,
    filename: "report.pdf",
    mimeType: "application/pdf",
  };
  const part = {
    type: "document",
    source: { type: "url", value: url, mimeType: "application/pdf" },
    metadata: { filename: "report.pdf" },
  } as const;
  const message = (
    overrides: Partial<UIMessage<ChatClientTools>>,
  ): UIMessage<ChatClientTools> => ({
    id: "answer",
    role: "assistant",
    parts: [{ type: "text", content: "Here it is." }],
    ...overrides,
  });

  test("the live answer's metadata reads as the part the stored answer holds", () => {
    const [live] = toPersistedChatMessages([
      message({ metadata: { [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [file] } }),
    ]);
    const [stored] = toPersistedChatMessages([
      message({ parts: [{ type: "text", content: "Here it is." }, part] }),
    ]);
    expect(live?.parts).toEqual(stored?.parts ?? []);
  });

  test("a message holding both shows the file once", () => {
    const [shown] = toPersistedChatMessages([
      message({
        metadata: { [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [file] },
        parts: [{ type: "text", content: "Here it is." }, part],
      }),
    ]);
    expect(shown?.parts.filter(({ type }) => type === "document")).toHaveLength(
      1,
    );
  });

  test("only an answer reads it, and a malformed list adds nothing", () => {
    const [fromUser] = toPersistedChatMessages([
      message({
        role: "user",
        metadata: { [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [file] },
      }),
    ]);
    expect(fromUser?.parts).toHaveLength(1);
    for (const listed of [
      "report.pdf",
      [
        {
          url: "https://example.test/report.pdf",
          filename: "x",
          mimeType: "x",
        },
      ],
      [{ url }],
    ]) {
      const [shown] = toPersistedChatMessages([
        message({ metadata: { [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: listed } }),
      ]);
      expect(shown?.parts).toHaveLength(1);
    }
  });
});
