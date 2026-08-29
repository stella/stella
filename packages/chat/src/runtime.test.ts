import { describe, expect, test } from "bun:test";

import {
  ChatConfigurationError,
  createChatRuntime,
  resolveChatModelSelection,
} from "./runtime";

describe("chat runtime", () => {
  test("rejects a partially configured model selection", () => {
    expect(() =>
      resolveChatModelSelection({
        providers: [],
        selection: { modelId: "gpt", provider: null, reasoningEffort: null },
      }),
    ).toThrow(ChatConfigurationError);
  });

  test("rejects an empty provider even when automatic routing is selected", () => {
    expect(() =>
      resolveChatModelSelection({
        providers: [{ modelIds: [], provider: "openai" }],
        selection: { modelId: null, provider: null, reasoningEffort: null },
      }),
    ).toThrow(ChatConfigurationError);
  });

  test("records a structured stream failure", async () => {
    const runtime = createChatRuntime({
      async *transport() {
        throw new Error("offline");
      },
    });

    await runtime.send({
      content: "hello",
      id: "user-1",
      metadata: undefined,
      role: "user",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      error: { message: "offline" },
      isStreaming: false,
      messages: [{ id: "user-1" }],
    });
  });

  test("ignores late events from a stopped stream after a new send", async () => {
    let releaseStoppedStream: () => void = () => undefined;
    const stoppedStreamReleased = new Promise<void>((resolve) => {
      releaseStoppedStream = resolve;
    });
    let transportCall = 0;
    const runtime = createChatRuntime({
      async *transport() {
        transportCall += 1;
        if (transportCall === 1) {
          await stoppedStreamReleased;
          yield {
            message: {
              content: "stale",
              id: "stale-assistant",
              metadata: undefined,
              role: "assistant",
            },
            type: "message",
          };
          return;
        }
        yield {
          message: {
            content: "current",
            id: "current-assistant",
            metadata: undefined,
            role: "assistant",
          },
          type: "message",
        };
      },
    });

    const stoppedSend = runtime.send({
      content: "first",
      id: "user-1",
      metadata: undefined,
      role: "user",
    });
    runtime.stop();
    await runtime.send({
      content: "second",
      id: "user-2",
      metadata: undefined,
      role: "user",
    });
    releaseStoppedStream();
    await stoppedSend;

    expect(runtime.getSnapshot()).toMatchObject({
      error: undefined,
      isStreaming: false,
      messages: [
        { id: "user-1" },
        { id: "user-2" },
        { id: "current-assistant" },
      ],
    });
  });
});
