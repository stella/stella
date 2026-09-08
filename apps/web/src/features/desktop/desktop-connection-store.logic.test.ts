import { describe, expect, test } from "bun:test";

import {
  createDesktopConnectionStore,
  type DesktopConnectionState,
} from "@/features/desktop/desktop-connection-store.logic";

/**
 * Store wired to scripted collaborators: the test decides when the bridge
 * answers and when the link succeeds, and records what each was asked to do.
 */
const scriptedStore = () => {
  const bridgeAnswered = Promise.withResolvers<boolean>();
  const linked = Promise.withResolvers<string>();
  const linkCalls: number[] = [];
  const manualLinkCalls: number[] = [];
  const errors: unknown[] = [];
  const watchSignals: AbortSignal[] = [];
  const seen: DesktopConnectionState[] = [];

  const store = createDesktopConnectionStore({
    link: async () => {
      linkCalls.push(linkCalls.length);
      return await linked.promise;
    },
    manualLink: async () => {
      manualLinkCalls.push(manualLinkCalls.length);
      return "manual@example.com";
    },
    onError: (error) => {
      errors.push(error);
    },
    watch: async (signal) => {
      watchSignals.push(signal);
      return await bridgeAnswered.promise;
    },
  });

  store.subscribe(() => {
    seen.push(store.getState());
  });

  return {
    bridgeAnswered,
    errors,
    linkCalls,
    linked,
    manualLinkCalls,
    seen,
    store,
    watchSignals,
  };
};

/** The store's own await chain is several ticks deep. */
const flush = async () => {
  for (let tick = 0; tick < 10; tick++) {
    await Promise.resolve();
  }
};

describe("desktop connection store", () => {
  test("a mounted surface alone never touches the bridge", () => {
    const { store, watchSignals } = scriptedStore();
    store.retain();
    store.retain();

    expect(store.getState()).toEqual({ status: "idle" });
    expect(watchSignals.length).toBe(0);
  });

  test("the download gesture starts the watch and links when the bridge answers", async () => {
    const { bridgeAnswered, linked, seen, store, watchSignals } =
      scriptedStore();
    store.retain();

    const watching = store.startWatch();
    expect(store.getState()).toEqual({ status: "waiting" });
    expect(watchSignals.length).toBe(1);

    bridgeAnswered.resolve(true);
    await flush();
    expect(store.getState()).toEqual({ status: "connecting" });

    linked.resolve("lawyer@example.com");
    await watching;
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
    expect(seen.map(({ status }) => status)).toEqual([
      "waiting",
      "connecting",
      "connected",
    ]);
  });

  test("automatic watches never invoke the explicit-connect link", async () => {
    const { bridgeAnswered, linkCalls, linked, manualLinkCalls, store } =
      scriptedStore();
    store.retain();

    const watching = store.startWatch();
    bridgeAnswered.resolve(true);
    linked.resolve("watch@example.com");
    await watching;

    expect(linkCalls.length).toBe(1);
    expect(manualLinkCalls.length).toBe(0);
  });

  test("manual connect invokes the explicit-connect link", async () => {
    const { manualLinkCalls, store } = scriptedStore();
    store.retain();

    expect(await store.connect(true)).toEqual({
      status: "connected",
      email: "manual@example.com",
    });
    expect(manualLinkCalls.length).toBe(1);
  });

  test("a watch that finds nothing falls back to saying nothing", async () => {
    const { bridgeAnswered, linkCalls, store } = scriptedStore();
    store.retain();

    const watching = store.startWatch();
    bridgeAnswered.resolve(false);
    await watching;

    expect(store.getState()).toEqual({ status: "idle" });
    expect(linkCalls.length).toBe(0);
  });

  test("a manual connect during the watch joins the running attempt", async () => {
    const { bridgeAnswered, linkCalls, linked, store } = scriptedStore();
    store.retain();
    const watching = store.startWatch();
    bridgeAnswered.resolve(true);
    await flush();

    const manual = store.connect();
    linked.resolve("lawyer@example.com");

    expect(await manual).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
    await watching;
    expect(linkCalls.length).toBe(1);
  });

  test("a manual link that wins retires the watch instead of linking twice", async () => {
    const { bridgeAnswered, linkCalls, linked, store, watchSignals } =
      scriptedStore();
    store.retain();
    const watching = store.startWatch();

    linked.resolve("lawyer@example.com");
    expect(await store.connect()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
    expect(watchSignals[0]?.aborted).toBe(true);

    // The bridge answers only now, with the watch still between probes when
    // the click landed.
    bridgeAnswered.resolve(true);
    await watching;
    expect(linkCalls.length).toBe(1);
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
  });

  test("a failed link reports the error and keeps the UI on the error state", async () => {
    const { bridgeAnswered, errors, linked, store } = scriptedStore();
    store.retain();
    const watching = store.startWatch();
    bridgeAnswered.resolve(true);
    await flush();

    const failure = new Error("bridge refused the link");
    linked.reject(failure);
    await watching;

    expect(store.getState()).toEqual({ status: "error" });
    expect(errors).toEqual([failure]);
  });

  test("a retry after a failure runs a fresh attempt", async () => {
    const { bridgeAnswered, linkCalls, linked, store } = scriptedStore();
    store.retain();
    const watching = store.startWatch();
    bridgeAnswered.resolve(true);
    await flush();
    linked.reject(new Error("bridge refused the link"));
    await watching;

    // The scripted link keeps failing, so the retry fails too; what matters
    // is that it ran at all instead of joining the finished attempt.
    expect(await store.connect()).toEqual({ status: "error" });
    expect(linkCalls.length).toBe(2);
  });

  test("a second gesture shares the one watch and the one link", async () => {
    const { bridgeAnswered, linkCalls, linked, store, watchSignals } =
      scriptedStore();
    store.retain();
    const watching = store.startWatch();
    const second = store.startWatch();

    expect(watchSignals.length).toBe(1);

    bridgeAnswered.resolve(true);
    linked.resolve("lawyer@example.com");
    await Promise.all([watching, second]);
    expect(linkCalls.length).toBe(1);
  });

  test("the watch survives one surface unmounting and stops with the last", async () => {
    const { bridgeAnswered, store, watchSignals } = scriptedStore();
    const first = store.retain();
    const second = store.retain();
    const watching = store.startWatch();
    const signal = watchSignals[0];

    first();
    expect(signal?.aborted).toBe(false);

    second();
    expect(signal?.aborted).toBe(true);
    expect(store.getState()).toEqual({ status: "idle" });

    bridgeAnswered.resolve(false);
    await watching;
  });

  test("a gesture after the link does not watch again", async () => {
    const { bridgeAnswered, linked, store, watchSignals } = scriptedStore();
    store.retain();
    const watching = store.startWatch();
    bridgeAnswered.resolve(true);
    linked.resolve("lawyer@example.com");
    await watching;

    await store.startWatch();
    expect(watchSignals.length).toBe(1);
    expect(store.getState()).toEqual({
      status: "connected",
      email: "lawyer@example.com",
    });
  });
});
