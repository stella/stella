import { Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  ChatLocalRunReadiness,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { createTestClock, deferred } from "@stll/test-kit";

import {
  createDesktopLaunch,
  DESKTOP_LAUNCH_POLL_MS,
  DESKTOP_LAUNCH_TIMEOUT_MS,
  type DesktopLaunchOutcome,
  heldForDesktop,
  needsDesktopLaunch,
  type ReadComputerConnected,
} from "./desktop-launch.logic";

class ReadFailedError extends TaggedError("ReadFailedError")<{
  message: string;
}> {}

/** Further than any launch in these tests waits, extensions included. */
const BEYOND_EVERY_DEADLINE_MS = 10 * DESKTOP_LAUNCH_TIMEOUT_MS;

/**
 * A launch on a test clock that moves only when `settle` moves it. `reads`
 * answers each read in turn (the last answer repeats; `hangs` never
 * answers). `onRead` sees the clock at every read, so a test can act at a
 * given moment.
 */
const launchHarness = (
  reads: readonly (boolean | "fails" | "hangs")[],
  onRead: (elapsed: number) => void = () => undefined,
) => {
  const clock = createTestClock();
  const opened: number[] = [];
  let readCount = 0;
  const abandonedReads: number[] = [];
  const desktop = createDesktopLaunch({
    openDesktop: () => {
      opened.push(clock.monotonic());
    },
    now: clock.monotonic,
    sleep: async (milliseconds, signal) => {
      await clock.sleep(milliseconds, { signal });
    },
  });
  const read: ReadComputerConnected = async (signal) => {
    onRead(clock.monotonic());
    const answer = reads[Math.min(readCount, reads.length - 1)] ?? false;
    const index = readCount;
    readCount += 1;
    if (answer === "hangs") {
      signal.addEventListener("abort", () => {
        abandonedReads.push(index);
      });
      return await deferred<Result<boolean, Error>>().promise;
    }
    return answer === "fails"
      ? Result.err(new ReadFailedError({ message: "read failed" }))
      : Result.ok(answer);
  };
  /** Runs the clock until `outcome` settles; when, on the launch's clock. */
  const settle = async <T>(outcome: Promise<T>) => {
    const settled = outcome.then((value) => ({
      value,
      at: clock.monotonic(),
    }));
    await clock.advance(BEYOND_EVERY_DEADLINE_MS);
    return await settled;
  };
  return {
    desktop,
    read,
    opened,
    abandonedReads,
    reads: () => readCount,
    settle,
  };
};

describe("a desktop launch", () => {
  test("opens the desktop once, inside the call, and reports connected once a computer connects", async () => {
    const harness = launchHarness([false, false, true]);

    const outcome = harness.desktop.launch(harness.read);

    // The link went out synchronously, inside the gesture that called it.
    expect(harness.opened).toEqual([0]);
    expect(harness.desktop.state()).toEqual({ type: "opening" });
    expect(harness.desktop.pending()).not.toBeNull();

    expect(await harness.settle(outcome)).toEqual({
      value: "connected",
      at: 2 * DESKTOP_LAUNCH_POLL_MS,
    });
    expect(harness.opened).toEqual([0]);
    expect(harness.desktop.state()).toEqual({ type: "idle" });
    expect(harness.desktop.pending()).toBeNull();
  });

  test("times out at its deadline without opening the desktop again", async () => {
    const harness = launchHarness([false]);

    expect(await harness.settle(harness.desktop.launch(harness.read))).toEqual({
      value: "timed_out",
      at: DESKTOP_LAUNCH_TIMEOUT_MS,
    });
    expect(harness.opened).toEqual([0]);
    // One read at the start, one per poll, and one at the deadline.
    expect(harness.reads()).toBe(
      Math.ceil(DESKTOP_LAUNCH_TIMEOUT_MS / DESKTOP_LAUNCH_POLL_MS) + 1,
    );
    expect(harness.desktop.state()).toEqual({ type: "idle" });
  });

  test("times out at its deadline while a read is still out, and abandons that read", async () => {
    const harness = launchHarness([false, "hangs"]);

    expect(await harness.settle(harness.desktop.launch(harness.read))).toEqual({
      value: "timed_out",
      at: DESKTOP_LAUNCH_TIMEOUT_MS,
    });
    expect(harness.reads()).toBe(2);
    expect(harness.abandonedReads).toEqual([1]);
    expect(harness.desktop.state()).toEqual({ type: "idle" });
  });

  test("keeps waiting through a read that failed", async () => {
    const harness = launchHarness(["fails", true]);

    expect(
      (await harness.settle(harness.desktop.launch(harness.read))).value,
    ).toBe("connected");
    expect(harness.reads()).toBe(2);
  });

  test("a second gesture while it waits opens the desktop once more and joins the same wait with a fresh deadline", async () => {
    const SECOND_GESTURE_AT = 40_000;
    const joined: {
      outcome: Promise<DesktopLaunchOutcome>;
      waitBefore: unknown;
      waitAfter: unknown;
    }[] = [];
    const harness = launchHarness([false], (elapsed) => {
      if (elapsed === SECOND_GESTURE_AT) {
        const waitBefore = harness.desktop.pending()?.outcome;
        const outcome = harness.desktop.launch(harness.read);
        joined.push({
          outcome,
          waitBefore,
          waitAfter: harness.desktop.pending()?.outcome,
        });
      }
    });

    const first = harness.desktop.launch(harness.read);

    expect(await harness.settle(first)).toEqual({
      value: "timed_out",
      at: SECOND_GESTURE_AT + DESKTOP_LAUNCH_TIMEOUT_MS,
    });
    // The second gesture joined the wait under way instead of starting one.
    expect(joined).toHaveLength(1);
    expect(joined[0]?.waitAfter).toBe(joined[0]?.waitBefore);
    expect(await joined[0]?.outcome).toBe("timed_out");
    expect(harness.opened).toEqual([0, SECOND_GESTURE_AT]);
  });

  test("a launch after one ended opens the desktop and waits afresh", async () => {
    const harness = launchHarness([true]);

    expect(
      (await harness.settle(harness.desktop.launch(harness.read))).value,
    ).toBe("connected");
    const again = harness.desktop.launch(harness.read);

    expect(harness.opened).toHaveLength(2);
    expect(harness.desktop.pending()).not.toBeNull();
    expect((await harness.settle(again)).value).toBe("connected");
  });
});

/** Drains a held send, recording when it called `send` and when it held. */
const drainHeld = async (
  options: Omit<
    Parameters<typeof heldForDesktop<string>>[0],
    "onHold" | "send"
  >,
) => {
  const events: string[] = [];
  const chunks: string[] = [];
  const held = heldForDesktop({
    ...options,
    onHold: (holding) => {
      events.push(holding ? "hold" : "release");
    },
    async *send() {
      events.push("send");
      yield await Promise.resolve("posted");
    },
  });
  const drained = (async () => {
    for await (const chunk of held) {
      chunks.push(chunk);
    }
  })();
  return { events, chunks, drained };
};

describe("a turn held while the desktop opens", () => {
  test("open, wait, connected: the turn is sent once the computer connects", async () => {
    const harness = launchHarness([false, true]);
    const outcome = harness.desktop.launch(harness.read);
    const turn = await drainHeld({
      outcome,
      signal: new AbortController().signal,
    });

    expect((await harness.settle(outcome)).value).toBe("connected");
    await turn.drained;

    expect(turn.events).toEqual(["hold", "release", "send"]);
    expect(turn.chunks).toEqual(["posted"]);
    expect(harness.opened).toHaveLength(1);
  });

  test("open, timeout: the turn still goes out, so the API's refusal is what the chat shows", async () => {
    const harness = launchHarness([false]);
    const outcome = harness.desktop.launch(harness.read);
    const turn = await drainHeld({
      outcome,
      signal: new AbortController().signal,
    });

    expect((await harness.settle(outcome)).value).toBe("timed_out");
    await turn.drained;

    expect(turn.events).toEqual(["hold", "release", "send"]);
    expect(harness.opened).toHaveLength(1);
  });

  test("nothing is sent while the launch waits", async () => {
    const waiting = deferred<DesktopLaunchOutcome>();
    const turn = await drainHeld({
      outcome: waiting.promise,
      signal: new AbortController().signal,
    });

    expect(turn.events).toEqual(["hold"]);

    waiting.resolve("connected");
    await turn.drained;

    expect(turn.events).toEqual(["hold", "release", "send"]);
  });

  test("a Stop while it waits sends nothing", async () => {
    const stop = new AbortController();
    const waiting = deferred<DesktopLaunchOutcome>();
    const turn = await drainHeld({
      outcome: waiting.promise,
      signal: stop.signal,
    });

    stop.abort();
    await turn.drained;
    waiting.resolve("connected");

    expect(turn.events).toEqual(["hold", "release"]);
    expect(turn.chunks).toEqual([]);
  });
});

describe("whether a turn needs the desktop opened", () => {
  const local: ChatRunTarget = {
    kind: "local",
    harness: "codex",
    model: "gpt-5-codex",
    approvals: "ask",
    reasoningEffort: null,
  };
  const runner = (connected: boolean) => ({
    desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
    connected,
    lastSeenAt: "2026-11-12T10:00:00.000Z",
    harnesses: [],
  });
  const enabled = (
    runners: ReturnType<typeof runner>[],
  ): ChatLocalRunReadiness => ({
    status: "enabled",
    runners,
    maxApprovals: "full_auto",
  });

  test.each([
    ["no computer has connected yet", local, enabled([]), true],
    ["every computer is disconnected", local, enabled([runner(false)]), true],
    [
      "one computer is connected",
      local,
      enabled([runner(false), runner(true)]),
      false,
    ],
    ["the turn runs in the cloud", { kind: "cloud" }, enabled([]), false],
    ["the member may not run turns there", local, { status: "hidden" }, false],
    ["the computers are not read yet", local, undefined, false],
  ] as const)("%s", (_case, target, readiness, expected) => {
    expect(needsDesktopLaunch(target, readiness)).toBe(expected);
  });
});
