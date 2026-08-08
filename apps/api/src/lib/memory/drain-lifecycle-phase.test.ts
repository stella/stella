import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { drainMemoryLifecyclePhase } from "@/api/lib/memory/drain-lifecycle-phase";

// The curator drains a phase in a loop, so the only bugs that matter here are
// liveness ones: a loop that never ends, or one that ends too early and leaves
// a backlog to grow. Each test pins one of those.

const BATCH_SIZE = 3;

const idsFor = (count: number): { id: SafeId<"aiMemory"> }[] =>
  Array.from({ length: count }, () => ({
    id: toSafeId<"aiMemory">(Bun.randomUUIDv7()),
  }));

/**
 * A fake phase over a finite queue: `selectBatch` peeks, `transitionBatch`
 * consumes. Mirrors the real predicates, where the UPDATE removes exactly the
 * rows the SELECT matched.
 */
const consumingPhase = (backlog: number) => {
  let remaining = backlog;
  return {
    batchSize: BATCH_SIZE,
    maxBatches: 1000,
    signal: new AbortController().signal,
    selectBatch: async () => idsFor(Math.min(remaining, BATCH_SIZE)),
    transitionBatch: async (ids: readonly SafeId<"aiMemory">[]) => {
      remaining -= ids.length;
      return ids.map((id) => ({ id }));
    },
  };
};

describe("drainMemoryLifecyclePhase", () => {
  test("drains a backlog spanning many batches, not just the first", async () => {
    // The bug this guards: returning after one batch leaves 7 of 10 rows
    // behind every run, so the backlog outpaces the sweep.
    const drained = await drainMemoryLifecyclePhase(consumingPhase(10));

    expect(drained).toBe(10);
  });

  test("stops at an empty backlog without a further transition", async () => {
    let transitions = 0;
    const drained = await drainMemoryLifecyclePhase({
      ...consumingPhase(0),
      transitionBatch: async () => {
        transitions += 1;
        return [];
      },
    });

    expect(drained).toBe(0);
    expect(transitions).toBe(0);
  });

  test("terminates when the transition matches nothing the select found", async () => {
    // Predicate drift (or a concurrent run winning the rows): select keeps
    // returning a full batch while the update changes nothing. Without the
    // empty-transition guard this loops forever.
    let selects = 0;
    const drained = await drainMemoryLifecyclePhase({
      batchSize: BATCH_SIZE,
      maxBatches: 1000,
      signal: new AbortController().signal,
      selectBatch: async () => {
        selects += 1;
        return idsFor(BATCH_SIZE);
      },
      transitionBatch: async () => [],
    });

    expect(drained).toBe(0);
    expect(selects).toBe(1);
  });

  test("caps the batches a single run may process", async () => {
    // A backlog that never shrinks must still yield the scheduler slot.
    let selects = 0;
    const drained = await drainMemoryLifecyclePhase({
      batchSize: BATCH_SIZE,
      maxBatches: 5,
      signal: new AbortController().signal,
      selectBatch: async () => {
        selects += 1;
        return idsFor(BATCH_SIZE);
      },
      transitionBatch: async (ids) => ids.map((id) => ({ id })),
    });

    expect(selects).toBe(5);
    expect(drained).toBe(5 * BATCH_SIZE);
  });

  test("aborts mid-drain instead of finishing the backlog", async () => {
    const controller = new AbortController();
    let selects = 0;

    const thrown = await drainMemoryLifecyclePhase({
      batchSize: BATCH_SIZE,
      maxBatches: 1000,
      signal: controller.signal,
      selectBatch: async () => {
        selects += 1;
        controller.abort();
        return idsFor(BATCH_SIZE);
      },
      transitionBatch: async (ids) => ids.map((id) => ({ id })),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // The first batch aborts, so the second recursion must panic rather than
    // keep draining; a null here means the drain ran to completion instead.
    expect(thrown).not.toBeNull();
    expect(selects).toBe(1);
  });
});
