import { describe, expect, test } from "bun:test";

import {
  connectWorkspaceStream,
  SSE_ESCALATE_AFTER_FAILURES,
  sseReconnectDelayMs,
  WORKSPACE_STREAM_ACCESS,
  workspaceStreamAccessFromStatus,
} from "@/lib/workspace-sse-connection.logic";
import type {
  WorkspaceStreamAccess,
  WorkspaceStreamHandlers,
} from "@/lib/workspace-sse-connection.logic";

type FakeSource = {
  handlers: WorkspaceStreamHandlers;
  /** The browser gave up retrying (readyState CLOSED). */
  givenUp: boolean;
  closedByClient: boolean;
};

type ScheduledReconnect = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

/**
 * Drives the connection loop the way a browser drives an EventSource: opens,
 * native retries (an `error` while CONNECTING, then `open` again), and giving
 * up (an `error` once CLOSED). Timers and the access probe are in the test's
 * hands, so every transition is explicit.
 */
const createHarness = (
  probe: () => WorkspaceStreamAccess = () => WORKSPACE_STREAM_ACCESS.AVAILABLE,
) => {
  const sources: FakeSource[] = [];
  const reconnects: ScheduledReconnect[] = [];
  const calls = { accessEnded: 0, outages: 0, probes: 0, reconnected: 0 };

  const dispose = connectWorkspaceStream({
    openSource: (handlers) => {
      const source: FakeSource = {
        handlers,
        givenUp: false,
        closedByClient: false,
      };
      sources.push(source);
      return {
        isClosed: () => source.givenUp,
        close: () => {
          source.closedByClient = true;
        },
      };
    },
    isOnline: () => true,
    schedule: (callback, delayMs) => {
      const reconnect = { callback, delayMs, cancelled: false };
      reconnects.push(reconnect);
      return () => {
        reconnect.cancelled = true;
      };
    },
    probeAccess: (settle) => {
      calls.probes += 1;
      // The real probe is a request; its answer never arrives synchronously.
      queueMicrotask(() => {
        settle(probe());
      });
    },
    onMessage: () => undefined,
    onOutage: () => {
      calls.outages += 1;
    },
    onAccessEnded: () => {
      calls.accessEnded += 1;
    },
    onReconnected: () => {
      calls.reconnected += 1;
    },
  });

  const current = (): FakeSource => sources.at(-1) ?? panicNoSource();

  /** The browser gives up on the current source; let the probe settle. */
  const giveUp = async () => {
    const source = current();
    source.givenUp = true;
    source.handlers.onError();
    await Bun.sleep(0);
  };

  /** Fire the pending reconnect timer, as the clock would. */
  const fireReconnect = () => {
    const pending = reconnects.at(-1);
    if (!pending || pending.cancelled) {
      throw new Error("No reconnect is scheduled");
    }
    pending.callback();
  };

  return {
    calls,
    current,
    dispose,
    fireReconnect,
    giveUp,
    reconnects,
    sources,
  };
};

const panicNoSource = (): never => {
  throw new Error("No source was opened");
};

describe("workspace stream access probe", () => {
  test("reads only a not-found refusal as the end of matter access", () => {
    expect(workspaceStreamAccessFromStatus(404)).toBe(
      WORKSPACE_STREAM_ACCESS.ENDED,
    );
    for (const status of [null, 200, 401, 403, 429, 500, 502, 503]) {
      expect([status, workspaceStreamAccessFromStatus(status)]).toEqual([
        status,
        WORKSPACE_STREAM_ACCESS.AVAILABLE,
      ]);
    }
  });
});

describe("workspace stream reconnects", () => {
  test("stops reconnecting and ends matter access when the reconnect is refused as not found", async () => {
    const harness = createHarness(() => WORKSPACE_STREAM_ACCESS.ENDED);
    harness.current().handlers.onOpen();

    await harness.giveUp();

    expect(harness.calls).toEqual({
      accessEnded: 1,
      outages: 0,
      probes: 1,
      reconnected: 0,
    });
    expect(harness.reconnects).toEqual([]);
    expect(harness.sources).toHaveLength(1);
    expect(harness.current().closedByClient).toBe(true);
  });

  test("ends matter access without reporting an outage even after earlier failed reconnects", async () => {
    let access: WorkspaceStreamAccess = WORKSPACE_STREAM_ACCESS.AVAILABLE;
    const harness = createHarness(() => access);
    for (let failure = 1; failure < SSE_ESCALATE_AFTER_FAILURES; failure += 1) {
      await harness.giveUp();
      harness.fireReconnect();
    }
    access = WORKSPACE_STREAM_ACCESS.ENDED;

    await harness.giveUp();

    expect(harness.calls.accessEnded).toBe(1);
    expect(harness.calls.outages).toBe(0);
    expect(harness.reconnects).toHaveLength(SSE_ESCALATE_AFTER_FAILURES - 1);
  });

  test("keeps reconnecting with backoff through an outage and reports it once", async () => {
    const harness = createHarness();
    const failures = SSE_ESCALATE_AFTER_FAILURES + 2;
    for (let failure = 1; failure <= failures; failure += 1) {
      await harness.giveUp();
      harness.fireReconnect();
    }

    expect(harness.calls).toEqual({
      accessEnded: 0,
      outages: 1,
      probes: failures,
      reconnected: 0,
    });
    expect(harness.reconnects.map(({ delayMs }) => delayMs)).toEqual(
      Array.from({ length: failures }, (_, index) =>
        sseReconnectDelayMs(index + 1),
      ),
    );
    expect(harness.sources).toHaveLength(failures + 1);
  });

  test("ignores the browser's own retries while the source is still connecting", async () => {
    const harness = createHarness();
    harness.current().handlers.onOpen();

    harness.current().handlers.onError();
    await Bun.sleep(0);

    expect(harness.calls.probes).toBe(0);
    expect(harness.reconnects).toEqual([]);
  });

  test("refreshes the matter on every reopen after the first open", async () => {
    const harness = createHarness();
    harness.current().handlers.onOpen();
    expect(harness.calls.reconnected).toBe(0);

    // The browser's own retry: the source drops while connected and reopens.
    harness.current().handlers.onError();
    harness.current().handlers.onOpen();
    expect(harness.calls.reconnected).toBe(1);

    // The loop's retry: the browser gives up and a new source opens.
    await harness.giveUp();
    harness.fireReconnect();
    harness.current().handlers.onOpen();
    expect(harness.calls.reconnected).toBe(2);
    expect(harness.sources).toHaveLength(2);
  });

  test("does not refresh when the first connection only opens after failed attempts", async () => {
    // Nothing was delivered before the first open, so there is nothing the
    // stream could have missed; the route loader fetched the matter already.
    const harness = createHarness();
    await harness.giveUp();
    harness.fireReconnect();
    harness.current().handlers.onOpen();

    expect(harness.calls.reconnected).toBe(0);
  });

  test("does not reconnect or end access once disposed mid-probe", async () => {
    const harness = createHarness(() => WORKSPACE_STREAM_ACCESS.ENDED);
    const source = harness.current();
    source.givenUp = true;
    source.handlers.onError();
    harness.dispose();
    await Bun.sleep(0);

    expect(harness.calls.accessEnded).toBe(0);
    expect(harness.reconnects).toEqual([]);
  });
});
