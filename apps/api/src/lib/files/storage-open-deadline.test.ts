import { describe, expect, test } from "bun:test";

import { openWithinDeadline } from "./storage-open-deadline";

/** A clock the test advances by hand: `fire` runs every pending deadline. */
const manualClock = () => {
  const pending = new Set<() => void>();
  return {
    schedule: (run: () => void) => {
      pending.add(run);
      return {
        clear: () => {
          pending.delete(run);
        },
      };
    },
    fire: () => {
      for (const run of [...pending]) {
        pending.delete(run);
        run();
      }
    },
    pendingCount: () => pending.size,
  };
};

const chunks = [
  new TextEncoder().encode("first part, "),
  new TextEncoder().encode("second part"),
];

/**
 * A storage body whose second chunk is held until `release`, so the test
 * decides when the download is still streaming. Pulls fail once the signal
 * the store was opened with aborts, as an aborted GET body does.
 */
const pausedBody = (signal: AbortSignal, release: Promise<undefined>) => {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (index === 1) {
        await release;
      }
      signal.throwIfAborted();
      const chunk = chunks.at(index);
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

const readAll = async (body: ReadableStream<Uint8Array>) =>
  new TextDecoder().decode(await new Response(body).arrayBuffer());

describe("storage open deadline", () => {
  test("a body still streaming when the open deadline passes is delivered whole", async () => {
    const clock = manualClock();
    const release = Promise.withResolvers<undefined>();
    let openedWith: AbortSignal | undefined;
    const body = await openWithinDeadline({
      open: async (signal) => {
        openedWith = signal;
        return await Promise.resolve(pausedBody(signal, release.promise));
      },
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      schedule: clock.schedule,
    });
    const delivered = readAll(body);

    // The headers arrived: the deadline is gone, and time passing past it
    // while the body streams aborts nothing.
    expect(clock.pendingCount()).toBe(0);
    clock.fire();
    release.resolve(undefined);

    expect(await delivered).toBe("first part, second part");
    expect(openedWith?.aborted).toBe(false);
  });

  test("an open that has not answered by the deadline is aborted", async () => {
    const clock = manualClock();
    const opening = openWithinDeadline({
      open: async (signal) => {
        const answered = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => {
          answered.reject(signal.reason);
        });
        return await answered.promise;
      },
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      schedule: clock.schedule,
    });
    clock.fire();
    expect(
      await opening.then(
        () => "opened",
        (error: unknown) =>
          error instanceof DOMException ? error.name : "other",
      ),
    ).toBe("TimeoutError");
  });

  test("a client that disconnects mid-stream stops the body", async () => {
    const clock = manualClock();
    const client = new AbortController();
    const release = Promise.withResolvers<undefined>();
    const body = await openWithinDeadline({
      open: async (signal) =>
        await Promise.resolve(pausedBody(signal, release.promise)),
      signal: client.signal,
      timeoutMs: 30_000,
      schedule: clock.schedule,
    });
    const delivered = readAll(body).then(
      () => "delivered",
      () => "stopped",
    );
    client.abort();
    release.resolve(undefined);
    expect(await delivered).toBe("stopped");
  });
});
