import { afterEach, expect, test } from "bun:test";

import { ChatReconnectError } from "@stll/chat/durable-transport";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import { createChatRuntime } from "./chat-runtime";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const openLoadedTurn = () => {
  const errors: Error[] = [];
  let reloads = 0;
  const runtime = createChatRuntime({
    activeTurnId: toSafeId<"chatTurn">("018f0000-0000-7000-8000-00000000000a"),
    context: undefined,
    initialMessages: [
      {
        id: "partial",
        role: "assistant",
        parts: [{ type: "text", content: "Drafting" }],
      },
    ],
    key: { scope: "global", threadId: toChatThreadId("thread-rejoin") },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => {
      reloads += 1;
    },
  });
  return { runtime, errors, reloads: () => reloads };
};

const awaitProbe = async (
  runtime: ReturnType<typeof openLoadedTurn>["runtime"],
) => {
  const settled = Promise.withResolvers<undefined>();
  const unsubscribe = runtime.subscribe(() => {
    if (!runtime.getSnapshot().reconnecting) {
      settled.resolve(undefined);
    }
  });
  await settled.promise;
  unsubscribe();
};

test("a missing running turn refreshes settled history once after its loader probe", async () => {
  let probes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      probes += 1;
      if (probes > 1) {
        return Response.json({ type: "transcript", turnId: "turn-rejoin" });
      }
      return Response.json({ message: "Unknown turn" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
  const page = openLoadedTurn();
  await awaitProbe(page.runtime);
  expect(probes).toBe(1);
  expect(page.reloads()).toBe(1);
  expect(page.errors).toEqual([]);
  expect(page.runtime.getSnapshot().turnAbandoned).toBe(true);
});

test("unauthorized rejoin probes stop immediately without retrying or presenting a settled transcript", async () => {
  for (const status of [401, 403]) {
    let probes = 0;
    globalThis.fetch = Object.assign(
      async () => {
        probes += 1;
        if (probes > 1) {
          return Response.json({ type: "transcript", turnId: "turn-rejoin" });
        }
        return Response.json({ message: "Access refused" }, { status });
      },
      { preconnect: () => undefined },
    );
    const page = openLoadedTurn();
    await awaitProbe(page.runtime);
    expect(probes).toBe(1);
    expect(page.reloads()).toBe(0);
    expect(page.errors).toHaveLength(1);
    expect(page.errors.at(0)).toBeInstanceOf(ChatReconnectError);
    expect(page.errors.at(0)).toMatchObject({ code: "refused" });
  }
});

test("a transient server failure retries the runtime probe before refreshing settled history", async () => {
  let probes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      probes += 1;
      if (probes === 1) {
        return Response.json(
          { message: "Temporarily unavailable" },
          { status: 500 },
        );
      }
      return Response.json({ message: "Unknown turn" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
  const page = openLoadedTurn();
  await awaitProbe(page.runtime);
  expect(probes).toBe(2);
  expect(page.reloads()).toBe(1);
  expect(page.errors).toEqual([]);
  expect(page.runtime.getSnapshot().turnAbandoned).toBe(true);
});
