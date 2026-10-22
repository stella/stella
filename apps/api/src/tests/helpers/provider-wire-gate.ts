import { panic, TaggedError } from "better-result";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { API_TEST_TIMEOUT_MS } from "@/api/tests/test-timeouts";

// Pause points in a replayed provider response. A transcript labels a frame
// of an answer; when the replay is about to send the bytes after it, the
// response goes quiet until the test releases the label, so the test can act
// (stop the turn, answer a card, drop the page's connection, queue a
// message) while the provider is mid-answer, then let the answer go on. An
// aborted request stops waiting: its response ends the way an aborted fetch
// does.

/** The conversation left its transcript before reaching a pause point. */
class ReplayDiverged extends TaggedError("ReplayDiverged")<{
  message: string;
}> {}

type GateState = {
  reached: PromiseWithResolvers<undefined>;
  released: PromiseWithResolvers<undefined>;
  /** Whether the replay got to the label and when the test let it go. */
  status: "pending" | "reached" | "released";
};

export type ReplayGate = ReturnType<typeof createReplayGate>;

/** A gate for exactly `labels`: each must be reached once and released. */
export const createReplayGate = (labels: readonly string[]) => {
  const states = new Map<string, GateState>();
  for (const label of labels) {
    if (states.has(label)) {
      panic(`The pause label ${label} is declared twice`);
    }
    states.set(label, {
      reached: Promise.withResolvers<undefined>(),
      released: Promise.withResolvers<undefined>(),
      status: "pending",
    });
  }
  /** Settles once the conversation can no longer reach a pause point. */
  const failed = Promise.withResolvers<never>();
  // swallow-ok: `reached` reports the failure; a test that never waits on a pause point has nothing to report it to
  void failed.promise.catch(() => undefined);
  const stateOf = (label: string): GateState =>
    states.get(label) ?? panic(`No pause point is labelled ${label}`);

  return {
    /**
     * Called by the replay before it sends the bytes after `label`'s frame:
     * resolves once the test releases the label, or once `signal` aborts.
     */
    pause: async (label: string, signal: AbortSignal | null) => {
      const state = stateOf(label);
      if (state.status === "pending") {
        state.status = "reached";
      }
      state.reached.resolve(undefined);
      if (signal === null) {
        await state.released.promise;
        return;
      }
      if (signal.aborted) {
        return;
      }
      const aborted = Promise.withResolvers<undefined>();
      const onAbort = () => {
        aborted.resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([state.released.promise, aborted.promise]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    /** Resolves once the replay holds the response at `label`. */
    reached: async (label: string) => {
      const state = stateOf(label);
      await withTimeout(
        async () => await Promise.race([state.reached.promise, failed.promise]),
        {
          label: `The replay reaching the pause point ${label}`,
          timeoutMs: API_TEST_TIMEOUT_MS,
        },
      );
    },
    /** Fails every wait for a pause point: the replay refused a request, so
     *  the conversation went another way. */
    fail: (reason: string) => {
      failed.reject(new ReplayDiverged({ message: reason }));
    },
    /** Lets the response held at `label` go on. */
    release: (label: string) => {
      const state = stateOf(label);
      if (state.status === "pending") {
        panic(`The pause point ${label} was released before it was reached`);
      }
      state.status = "released";
      state.released.resolve(undefined);
    },
    /** Releases every label, for a test that ends early. */
    releaseAll: () => {
      for (const state of states.values()) {
        state.released.resolve(undefined);
      }
    },
    /** Labels the replay never reached, or the test never released. */
    unfinished: (): string[] =>
      [...states].flatMap(([label, { status }]) =>
        status === "released" ? [] : [`${label}: ${status}`],
      ),
  };
};
