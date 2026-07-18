import { describe, expect, mock, spyOn, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

type MessageHandler = (message: string) => void;

// Models a Bun RedisClient closely enough to exercise pub/sub loopback. Key
// modelled facts (all verified against a mock RESP3 server): `connected`
// reflects the socket; `subscribedLive` reflects whether the SERVER currently
// delivers pub/sub to this connection; a reconnect restores `connected` but NOT
// `subscribedLive` (Bun does not re-issue SUBSCRIBE); `publish` fans a message
// out only to clients that are `subscribedLive`.
type FakeRedisClient = {
  subscribe: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  onReconnect: ReturnType<typeof mock>;
  connected: boolean;
  subscribedLive: boolean;
  messageHandler: MessageHandler | null;
  reconnectHandlers: (() => void)[];
};

const createdClients: FakeRedisClient[] = [];
let subscribeBehavior: "reject" | "resolve" = "resolve";
// Number of subscribe() attempts to fail before succeeding, independent of
// subscribeBehavior. Lets a test model a transient boot blip (fail once,
// then the retry attaches) without permanently rejecting.
let subscribeFailuresRemaining = 0;

const makeFakeRedisClient = (): FakeRedisClient => {
  const client: FakeRedisClient = {
    subscribe: mock(async (_channel: string, handler: MessageHandler) => {
      if (subscribeFailuresRemaining > 0) {
        subscribeFailuresRemaining -= 1;
        throw new Error("redis unavailable");
      }
      if (subscribeBehavior === "reject") {
        throw new Error("redis unavailable");
      }
      // A confirmed subscribe: the server now delivers to this connection.
      client.messageHandler = handler;
      client.subscribedLive = true;
      client.connected = true;
    }),
    // Redis fans a published message out to every connection with a live
    // subscription. A reconnected-but-not-resubscribed client is absent here,
    // so it receives nothing — modelling the real deaf-after-reconnect hazard.
    publish: mock(async (_channel: string, message: string) => {
      for (const peer of createdClients) {
        if (peer.subscribedLive && peer.messageHandler) {
          peer.messageHandler(message);
        }
      }
    }),
    close: mock(() => {
      client.subscribedLive = false;
      client.connected = false;
    }),
    onReconnect: mock((handler: () => void) => {
      client.reconnectHandlers.push(handler);
      return () => {
        const index = client.reconnectHandlers.indexOf(handler);
        if (index !== -1) {
          client.reconnectHandlers.splice(index, 1);
        }
      };
    }),
    connected: false,
    subscribedLive: false,
    messageHandler: null,
    reconnectHandlers: [],
  };
  createdClients.push(client);
  return client;
};

// Model a transient socket drop + Bun auto-reconnect: the socket comes back
// (`connected` true) but the SERVER no longer has a subscription for it
// (`subscribedLive` false, because Bun does not re-issue SUBSCRIBE), then Bun
// fires the onconnect/reconnect handlers.
const simulateDeafReconnect = (client: FakeRedisClient): void => {
  client.connected = true;
  client.subscribedLive = false;
  client.messageHandler = null;
  for (const handler of [...client.reconnectHandlers]) {
    handler();
  }
};

const createRedisClientMock = mock(() => makeFakeRedisClient());

void mock.module("@/api/lib/redis-client", () => ({
  createRedisClient: createRedisClientMock,
}));

// setInterval/clearInterval are spied (not replaced) so startSse/stopSse
// still schedule and clear a real timer; the spies only let the tests
// observe whether the module called them, matching how sse.ts calls the
// global functions directly.
const setIntervalSpy = spyOn(globalThis, "setInterval");
const clearIntervalSpy = spyOn(globalThis, "clearInterval");

const { broadcast, startSse, stopSse, subscribe } =
  await import("@/api/lib/sse");

// Let the fire-and-forget subscribe promise inside startSse settle.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const workspaceId = toSafeId<"workspace">("ws_1");
const organizationId = toSafeId<"organization">("org_1");

describe("sse module import", () => {
  test("importing the module opens no Redis connection and starts no timer", () => {
    expect(createdClients).toHaveLength(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(createRedisClientMock).not.toHaveBeenCalled();
  });

  test("registering a local connection before startSse does not throw", () => {
    const controller = new AbortController();

    expect(() =>
      subscribe(workspaceId, organizationId, controller.signal),
    ).not.toThrow();

    controller.abort();
  });

  test("broadcasting before startSse does not throw", async () => {
    expect(() =>
      broadcast(workspaceId, { type: "test-event", data: null }),
    ).not.toThrow();

    await flushMicrotasks();
  });
});

describe("startSse / stopSse lifecycle", () => {
  test("startSse starts the keep-alive timer and connects the Redis subscriber", async () => {
    setIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.subscribe).toHaveBeenCalledTimes(1);

    stopSse();
    await flushMicrotasks();
  });

  test("startSse is idempotent: repeated calls create only one timer and one subscriber", async () => {
    setIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();
    startSse();
    startSse();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(createdClients).toHaveLength(1);

    stopSse();
    await flushMicrotasks();
  });

  test("stopSse clears the interval and closes the subscriber", async () => {
    clearIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();
    await flushMicrotasks();

    const client = createdClients[0];
    expect(client).toBeDefined();

    stopSse();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(client?.close).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
  });

  test("stopSse is safe when startSse was never called", () => {
    expect(() => stopSse()).not.toThrow();
  });

  test("stopSse is safe when called more than once", async () => {
    createdClients.length = 0;

    startSse();
    await flushMicrotasks();

    stopSse();
    expect(() => stopSse()).not.toThrow();

    await flushMicrotasks();
  });

  test("a Redis connection failure during startSse is logged and does not throw", async () => {
    subscribeBehavior = "reject";
    createdClients.length = 0;

    expect(() => startSse()).not.toThrow();

    await flushMicrotasks();

    // The client created for the failed connection attempt is still
    // closed, so a repeated failure does not leak a raw client handle.
    expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);

    stopSse();
    await flushMicrotasks();
    subscribeBehavior = "resolve";
  });

  test("stopping before the in-flight Redis connection resolves closes it instead of leaking it", async () => {
    createdClients.length = 0;

    startSse();
    // stopSse runs before the mocked subscribe() promise has settled.
    stopSse();

    await flushMicrotasks();

    expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
  });

  test("a stop+restart during connect does not attach the old subscriber to the new lifecycle", async () => {
    createdClients.length = 0;

    startSse();
    stopSse();
    // The first connection attempt is still in flight (its subscribe()
    // promise has not settled) when a new lifecycle starts.
    startSse();

    await flushMicrotasks();

    expect(createdClients).toHaveLength(2);
    const [oldClient, newClient] = createdClients;

    // The stale connection recognizes it no longer belongs to the active
    // lifecycle and closes itself instead of attaching to the new one.
    expect(oldClient?.close).toHaveBeenCalledTimes(1);
    expect(newClient?.close).not.toHaveBeenCalled();

    // The new lifecycle's subscriber is the one actually attached:
    // stopping it now closes newClient exactly once.
    stopSse();
    expect(newClient?.close).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
  });
});

describe("subscribe: already-aborted signal", () => {
  test("an already-aborted signal registers no connection and closes the stream", async () => {
    const controller = new AbortController();
    // The signal aborts before subscribe runs, mirroring a client that
    // disconnects during the async auth macro. With the leak, the stream
    // would stay open and registered forever; the fix closes it up front.
    controller.abort();

    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(true);

    // A subsequent broadcast must not resurrect or feed the dead stream:
    // nothing was registered, so there is nothing to enqueue into.
    broadcast(workspaceId, { type: "after-abort", data: null });
    await flushMicrotasks();

    const second = await reader.read();
    expect(second.done).toBe(true);
  });
});

describe("broadcast: local delivery without an attached subscriber", () => {
  test("broadcast delivers locally when no Redis subscriber is attached", async () => {
    // No startSse: this instance has no attached subscriber, so a
    // published event never loops back. Local clients must still get it.
    stopSse();
    await flushMicrotasks();

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    broadcast(workspaceId, { type: "local-only", data: { n: 1 } });

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("local-only");

    controller.abort();
    await flushMicrotasks();
  });
});

describe("broadcast: subscriber reconnect keeps delivery exactly-once", () => {
  const decode = (value: Uint8Array | undefined): string =>
    new TextDecoder().decode(value);

  test("delivers each event to local clients exactly once via loopback while subscribed", async () => {
    createdClients.length = 0;
    subscribeFailuresRemaining = 0;
    subscribeBehavior = "resolve";

    startSse();
    await flushMicrotasks();

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    // Subscribed: each event must arrive exactly once through the Redis
    // loopback (publish -> subscriber handler -> local delivery), never a
    // second inline copy. Reading two events in order proves the first was
    // delivered exactly once.
    broadcast(workspaceId, { type: "event-a", data: null });
    broadcast(workspaceId, { type: "event-b", data: null });

    expect(decode((await reader.read()).value)).toContain("event-a");
    expect(decode((await reader.read()).value)).toContain("event-b");

    controller.abort();
    stopSse();
    await flushMicrotasks();
  });

  test("a transient drop+reconnect re-subscribes via a fresh client and resumes exactly-once loopback delivery", async () => {
    createdClients.length = 0;
    subscribeFailuresRemaining = 0;
    subscribeBehavior = "resolve";

    startSse();
    await flushMicrotasks();
    const original = createdClients.at(-1);
    expect(original).toBeDefined();

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    // Baseline: loopback delivery works while subscribed.
    broadcast(workspaceId, { type: "before-drop", data: null });
    expect(decode((await reader.read()).value)).toContain("before-drop");

    // Bun reconnects the socket but does NOT re-issue SUBSCRIBE: the client is
    // connected yet deaf. sse.ts must tear it down and attach a FRESH client
    // (re-subscribing on the same client would double-register the callback).
    if (original) {
      simulateDeafReconnect(original);
    }
    await flushMicrotasks();

    // The deaf client was closed and a distinct replacement subscribed.
    expect(original?.close).toHaveBeenCalledTimes(1);
    const replacement = createdClients.at(-1);
    expect(replacement).not.toBe(original);
    expect(replacement?.subscribedLive).toBe(true);
    expect(replacement?.subscribe).toHaveBeenCalledTimes(1);

    // Loopback is restored through the replacement, still exactly once: if the
    // old code kept treating the reconnected client as attached, no loopback
    // would arrive and these reads would hang; if it re-subscribed on the same
    // client, each event would be delivered twice.
    broadcast(workspaceId, { type: "after-reconnect-1", data: null });
    broadcast(workspaceId, { type: "after-reconnect-2", data: null });
    expect(decode((await reader.read()).value)).toContain("after-reconnect-1");
    expect(decode((await reader.read()).value)).toContain("after-reconnect-2");

    controller.abort();
    stopSse();
    await flushMicrotasks();
  });

  test("while the replacement subscriber has not yet attached, broadcasts fall back to inline delivery", async () => {
    createdClients.length = 0;
    subscribeFailuresRemaining = 0;
    subscribeBehavior = "resolve";

    startSse();
    await flushMicrotasks();
    const original = createdClients.at(-1);
    expect(original).toBeDefined();

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    // The replacement attach will fail, so no subscriber is live: the instance
    // is effectively deaf. Broadcasts MUST still reach local clients inline so
    // nothing is missed during the reconnect/reattach window.
    subscribeBehavior = "reject";
    if (original) {
      simulateDeafReconnect(original);
    }
    await flushMicrotasks();

    broadcast(workspaceId, { type: "deaf-window", data: null });
    expect(decode((await reader.read()).value)).toContain("deaf-window");

    subscribeBehavior = "resolve";
    subscribeFailuresRemaining = 0;
    controller.abort();
    stopSse();
    await flushMicrotasks();
  });

  test("an own event broadcast during the attach window is delivered exactly once (loopback copy dropped)", async () => {
    createdClients.length = 0;
    subscribeFailuresRemaining = 0;
    subscribeBehavior = "resolve";

    startSse();
    await flushMicrotasks();
    const original = createdClients.at(-1);
    expect(original).toBeDefined();

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    // Enter the attach window: the replacement client's SUBSCRIBE is accepted
    // (subscribedLive), so the server loops events back, but sse.ts has not yet
    // set subscriptionLive, so hasAttachedSubscriber() is false. Do NOT flush.
    if (original) {
      simulateDeafReconnect(original);
    }
    const replacement = createdClients.at(-1);
    expect(replacement).not.toBe(original);
    expect(replacement?.subscribedLive).toBe(true);

    // Broadcast our own event in the window: delivered inline AND published with
    // our origin id + deliveredInline=true, so the copy that loops back through
    // the already-live subscription must be suppressed.
    broadcast(workspaceId, { type: "own-in-window", data: null });

    // Exactly one copy (the inline one). Attaching the replacement and then
    // broadcasting a steady event that rides loopback only; reading it second
    // proves the windowed event was not delivered twice.
    expect(decode((await reader.read()).value)).toContain("own-in-window");
    await flushMicrotasks();
    broadcast(workspaceId, { type: "after-window", data: null });
    expect(decode((await reader.read()).value)).toContain("after-window");

    controller.abort();
    stopSse();
    await flushMicrotasks();
  });

  test("a remote event received during the attach window is delivered via loopback", async () => {
    createdClients.length = 0;
    subscribeFailuresRemaining = 0;
    subscribeBehavior = "resolve";

    startSse();
    await flushMicrotasks();
    const original = createdClients.at(-1);

    const controller = new AbortController();
    const stream = subscribe(workspaceId, organizationId, controller.signal);
    const reader = stream.getReader();

    if (original) {
      simulateDeafReconnect(original);
    }
    const replacement = createdClients.at(-1);
    expect(replacement?.messageHandler).toBeTruthy();

    // Another instance's event arrives on our subscription during the window.
    // Inline delivery never covers remote events, and origin suppression only
    // drops OUR own inline-delivered events, so this must deliver via loopback.
    const remotePayload = JSON.stringify({
      scope: "workspace",
      id: workspaceId,
      event: { type: "remote-in-window", data: null },
      originInstanceId: "some-other-instance",
      deliveredInline: false,
    });
    replacement?.messageHandler?.(remotePayload);

    expect(decode((await reader.read()).value)).toContain("remote-in-window");

    controller.abort();
    stopSse();
    await flushMicrotasks();
  });
});

describe("startSse: subscriber attach retry", () => {
  test("a transient attach failure is retried and the subscriber attaches", async () => {
    createdClients.length = 0;
    // First attach attempt fails; the bounded backoff retry must attach.
    subscribeFailuresRemaining = 1;

    startSse();
    await flushMicrotasks();

    // The first attempt created a client, failed, and closed it.
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);

    // Wait past the first backoff delay (200ms) so the retry can run.
    await Bun.sleep(300);
    await flushMicrotasks();

    // A second client was created for the retry and stayed attached.
    expect(createdClients).toHaveLength(2);
    const attached = createdClients[1];
    expect(attached?.subscribe).toHaveBeenCalledTimes(1);
    expect(attached?.close).not.toHaveBeenCalled();

    // Stopping now closes the attached retry client exactly once.
    stopSse();
    expect(attached?.close).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    subscribeFailuresRemaining = 0;
  });

  test("keeps retrying at the capped interval and recovers after a prolonged outage", async () => {
    createdClients.length = 0;
    subscribeBehavior = "resolve";
    // Fail the whole 5-step ramp plus one steady attempt (6 failures), then
    // attach: proves retries continue past the ramp instead of giving up, so an
    // outage longer than the ramp still self-heals when Redis recovers.
    subscribeFailuresRemaining = 6;
    const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});

    startSse();
    // Bun.sleep is instant here, so the whole retry chain drains within
    // microtasks; a macrotask tick lets every attempt run to the eventual
    // success. A few ticks give margin.
    const tick = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    };
    await tick();
    await tick();
    await tick();

    // 7 clients: 6 failed attach attempts + the one that finally subscribed.
    expect(createdClients).toHaveLength(7);
    const attached = createdClients.at(-1);
    expect(attached?.subscribedLive).toBe(true);
    expect(attached?.subscribe).toHaveBeenCalledTimes(1);
    expect(attached?.close).not.toHaveBeenCalled();

    sleepSpy.mockRestore();
    subscribeFailuresRemaining = 0;
    stopSse();
    await flushMicrotasks();
  });
});
