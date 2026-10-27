import { panic } from "better-result";

type DrainSlot = {
  readonly ticket: { readonly completion: Promise<void> };
  readonly finish: ReturnType<typeof Promise.withResolvers<undefined>>;
};

type DrainState =
  | { type: "idle" }
  | { type: "running"; current: DrainSlot; pending: DrainSlot | null };

type DrainSettlement =
  { type: "fulfilled" } | { type: "rejected"; error: unknown };

const createSlot = (): DrainSlot => {
  const finish = Promise.withResolvers<undefined>();
  return { ticket: { completion: finish.promise }, finish };
};

/**
 * One running operation and one coalesced rerun. Background requests can ignore
 * their ticket without attaching a reaction; explicit callers await the exact
 * ticket they received, so later requests cannot extend their wait.
 *
 * The operation owns expected failure reporting. An unexpected rejection rejects
 * its ticket while allowing the pending operation to run.
 */
export const createCoalescedDrain = (run: () => Promise<void>) => {
  let state: DrainState = { type: "idle" };

  const start = (slot: DrainSlot) => {
    const settle = (outcome: DrainSettlement) => {
      if (state.type !== "running" || state.current !== slot) {
        panic("Only the running drain can settle its ticket");
      }
      const next = state.pending;
      state =
        next === null
          ? { type: "idle" }
          : { type: "running", current: next, pending: null };
      switch (outcome.type) {
        case "fulfilled":
          slot.finish.resolve(undefined);
          break;
        case "rejected":
          slot.finish.reject(outcome.error);
          break;
        default:
          panic("Unknown drain settlement", outcome satisfies never);
      }
      if (next !== null) {
        start(next);
      }
    };

    // Convert work failures before the terminal ticket bridge, so an invariant
    // failure in settle cannot trigger a second settlement.
    Promise.resolve()
      .then(run)
      .then(() => ({ type: "fulfilled" }) as const)
      .catch((error: unknown) => ({ type: "rejected", error }) as const)
      .then(settle);
  };

  return () => {
    if (state.type === "running") {
      if (state.pending === null) {
        state.pending = createSlot();
      }
      return state.pending.ticket;
    }
    const current = createSlot();
    state = { type: "running", current, pending: null };
    start(current);
    return current.ticket;
  };
};
