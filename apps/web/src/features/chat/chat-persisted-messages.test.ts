import { ChatClient } from "@tanstack/ai-client";
import type { ConnectConnectionAdapter } from "@tanstack/ai-client";
import { EventType } from "@tanstack/ai/client";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

import { withCurrentChatMessages } from "./chat-persisted-messages";

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
