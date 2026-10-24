import { afterEach, expect, test } from "bun:test";

import { ChatReconnectError } from "@stll/chat/durable-transport";
import { sleep } from "@stll/concurrency/sleep";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import { createChatRuntime } from "./chat-runtime";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

/** Wakes `awaitCondition` whenever the fixture server, the page's reload
 *  or a runtime the test subscribes to changes. */
const changeListeners = new Set<() => void>();
const notifyChange = () => {
  for (const listener of changeListeners) {
    listener();
  }
};

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
      notifyChange();
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

test("a running turn rejoins when its page mounts after the runtime was created", async () => {
  const RUN_ID = "run-rejoin";
  let joins = 0;
  const joined = Promise.withResolvers<undefined>();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/join")) {
        joins += 1;
        joined.resolve(undefined);
        return new Response(
          [
            { type: "RUN_STARTED", runId: RUN_ID, threadId: "thread-rejoin" },
            { type: "RUN_FINISHED", runId: RUN_ID, threadId: "thread-rejoin" },
          ]
            .map((event, id) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({
        type: "running",
        turnId: "turn-rejoin",
        runId: RUN_ID,
      });
    },
    { preconnect: () => undefined },
  );
  const page = openLoadedTurn();
  // Hydration subscribes well after the loader built the runtime.
  await sleep(50);
  const unsubscribe = page.runtime.subscribe(() => undefined);
  const deadline = Promise.withResolvers<undefined>();
  const deadlineTimer = setTimeout(() => {
    deadline.resolve(undefined);
  }, 2000);
  try {
    await Promise.race([joined.promise, deadline.promise]);
    expect(joins).toBe(1);
    expect(page.errors).toEqual([]);
  } finally {
    clearTimeout(deadlineTimer);
    unsubscribe();
  }
});

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

/** A thread whose loaded turn is still being prepared when the page mounts,
 *  and runs once the test lets its second probe answer. */
const installPreparingThenRunningServer = () => {
  const RUN_ID = "run-prepared";
  const probes: string[] = [];
  const joins: string[] = [];
  const running = Promise.withResolvers<undefined>();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/join")) {
        joins.push(url);
        notifyChange();
        return new Response(
          [
            { type: "RUN_STARTED", runId: RUN_ID, threadId: "thread-rejoin" },
            {
              type: "TEXT_MESSAGE_START",
              messageId: "partial",
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "partial",
              delta: "Drafting the reply",
            },
            { type: "TEXT_MESSAGE_END", messageId: "partial" },
            { type: "RUN_FINISHED", runId: RUN_ID, threadId: "thread-rejoin" },
          ]
            .map((event, id) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      probes.push(url);
      notifyChange();
      if (probes.length === 1) {
        return Response.json({ type: "preparing", turnId: "turn-rejoin" });
      }
      await running.promise;
      return Response.json({
        type: "running",
        turnId: "turn-rejoin",
        runId: RUN_ID,
      });
    },
    { preconnect: () => undefined },
  );
  return { joins, probes, run: () => running.resolve(undefined) };
};

const awaitCondition = async (condition: () => boolean) => {
  if (condition()) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const listener = () => {
    if (condition()) {
      done.resolve(undefined);
    }
  };
  changeListeners.add(listener);
  try {
    await done.promise;
  } finally {
    changeListeners.delete(listener);
  }
};

test("a running turn rejoins even when older history is prepended while its probe is pending", async () => {
  const server = installPreparingThenRunningServer();
  const page = openLoadedTurn();
  const unsubscribe = page.runtime.subscribe(notifyChange);
  try {
    await awaitCondition(() => server.probes.length === 2);
    // The fixture must reach the fault: the first probe found the turn still
    // being prepared, and the page is reconnecting while it asks again.
    expect(server.probes).toHaveLength(2);
    expect(page.runtime.getSnapshot().reconnecting).toBe(true);
    page.runtime.setMessages([
      {
        id: "older",
        role: "user",
        parts: [{ type: "text", content: "An earlier question" }],
      },
      ...page.runtime.getSnapshot().messages,
    ]);
    server.run();
    await awaitCondition(
      () => server.joins.length === 1 && !page.runtime.getSnapshot().isLoading,
    );

    expect(server.joins).toHaveLength(1);
    const shown = page.runtime.getSnapshot();
    expect(shown.reconnecting).toBe(false);
    expect(shown.messages.map(({ id }) => id)).toEqual(["older", "partial"]);
    expect(shown.messages.at(-1)?.parts).toEqual([
      { type: "text", content: "Drafting the reply" },
    ]);
    expect(page.reloads()).toBe(0);
    expect(page.errors).toEqual([]);
  } finally {
    unsubscribe();
  }
});

test("a running turn found after the page left reloads instead of reconnecting forever", async () => {
  const server = installPreparingThenRunningServer();
  const page = openLoadedTurn();
  const unsubscribe = page.runtime.subscribe(notifyChange);
  await awaitCondition(() => server.probes.length === 2);
  expect(page.runtime.getSnapshot().reconnecting).toBe(true);
  // The last view goes while the probe is pending: nobody tails the turn.
  unsubscribe();
  server.run();
  await awaitCondition(() => page.reloads() > 0);

  expect(server.joins).toHaveLength(0);
  expect(page.runtime.getSnapshot()).toMatchObject({
    reconnecting: false,
    turnAbandoned: true,
  });
  expect(page.reloads()).toBe(1);
  expect(page.errors).toEqual([]);
});
