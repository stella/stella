import { describe, expect, test } from "bun:test";

import {
  aggregateAnonymizationMatches,
  buildAnonymizationDetectionKey,
  buildExcludedCanonicalsSet,
  createTrailingSingleFlight,
  decideAnonymizationDetectionRun,
  dedupeDetectedAnonymizationTerms,
  mergeAnonymizationTerms,
  resolveCheckpointAutosaveStatus,
} from "./docx-edit-mode.logic";

/** Resolve every queued microtask (and the current macrotask). */
const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const gate = (): Gate => {
  let settle!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
};

const buffer = (values: number[]) => new Uint8Array(values).buffer;

describe("checkpoint autosave status", () => {
  test("syncs when the round-trip succeeds", () => {
    expect(
      resolveCheckpointAutosaveStatus({
        buffer: buffer([1]),
        checkpointSaved: true,
      }),
    ).toBe("synced");
  });

  test("stays pending when the round-trip fails", () => {
    expect(
      resolveCheckpointAutosaveStatus({
        buffer: buffer([1]),
        checkpointSaved: false,
      }),
    ).toBe("pending");
  });

  test("stays pending when serialization produced no buffer", () => {
    // A missing buffer is the only case where `checkpointSaved`
    // is never consulted; both flush and debounced paths short
    // out before persisting.
    expect(
      resolveCheckpointAutosaveStatus({ buffer: null, checkpointSaved: false }),
    ).toBe("pending");
    expect(
      resolveCheckpointAutosaveStatus({ buffer: null, checkpointSaved: true }),
    ).toBe("pending");
  });

  test("treats an empty buffer as present, not missing", () => {
    expect(
      resolveCheckpointAutosaveStatus({
        buffer: new ArrayBuffer(0),
        checkpointSaved: true,
      }),
    ).toBe("synced");
  });
});

describe("anonymization detection cache key", () => {
  test("is stable regardless of exclusion insertion order", () => {
    const a = buildAnonymizationDetectionKey({
      text: "Acme Corp",
      excludedCanonicals: new Set(["beta", "alpha"]),
    });
    const b = buildAnonymizationDetectionKey({
      text: "Acme Corp",
      excludedCanonicals: new Set(["alpha", "beta"]),
    });
    expect(a).toBe(b);
  });

  test("changes when the exclusion set changes", () => {
    const without = buildAnonymizationDetectionKey({
      text: "Acme Corp",
      excludedCanonicals: new Set(),
    });
    const withExclusion = buildAnonymizationDetectionKey({
      text: "Acme Corp",
      excludedCanonicals: new Set(["acme corp"]),
    });
    expect(without).not.toBe(withExclusion);
  });

  test("changes when the text changes", () => {
    const first = buildAnonymizationDetectionKey({
      text: "Acme Corp",
      excludedCanonicals: new Set(["alpha"]),
    });
    const second = buildAnonymizationDetectionKey({
      text: "Beta Corp",
      excludedCanonicals: new Set(["alpha"]),
    });
    expect(first).not.toBe(second);
  });
});

describe("anonymization detection decision", () => {
  test("skips while a request is still in flight", () => {
    expect(
      decideAnonymizationDetectionRun({
        text: "Acme",
        cacheKey: "k",
        lastDeliveredKey: null,
        inFlightUntil: 1000,
        now: 500,
      }),
    ).toEqual({ action: "skip" });
  });

  test("marks ran for an empty document", () => {
    expect(
      decideAnonymizationDetectionRun({
        text: "",
        cacheKey: "~",
        lastDeliveredKey: null,
        inFlightUntil: 0,
        now: 500,
      }),
    ).toEqual({ action: "markRan" });
  });

  test("treats an empty doc as ran even with a stale in-flight window", () => {
    // The in-flight check fires first only while the window is
    // open; once it has elapsed, an empty doc releases the lock.
    expect(
      decideAnonymizationDetectionRun({
        text: "",
        cacheKey: "~",
        lastDeliveredKey: null,
        inFlightUntil: 100,
        now: 500,
      }),
    ).toEqual({ action: "markRan" });
  });

  test("no-ops when results for the exact key already landed", () => {
    expect(
      decideAnonymizationDetectionRun({
        text: "Acme",
        cacheKey: "k",
        lastDeliveredKey: "k",
        inFlightUntil: 0,
        now: 500,
      }),
    ).toEqual({ action: "alreadyDelivered" });
  });

  test("runs for fresh text past the in-flight window", () => {
    expect(
      decideAnonymizationDetectionRun({
        text: "Acme",
        cacheKey: "k",
        lastDeliveredKey: "previous",
        inFlightUntil: 100,
        now: 500,
      }),
    ).toEqual({ action: "run" });
  });

  test("in-flight skip wins over an already-delivered key", () => {
    expect(
      decideAnonymizationDetectionRun({
        text: "Acme",
        cacheKey: "k",
        lastDeliveredKey: "k",
        inFlightUntil: 1000,
        now: 500,
      }),
    ).toEqual({ action: "skip" });
  });
});

describe("detected term deduplication", () => {
  test("collapses pairs sharing a label and case-insensitive original", () => {
    const terms = dedupeDetectedAnonymizationTerms([
      { original: "Acme", label: "organization" },
      { original: "acme", label: "organization" },
    ]);
    expect(terms).toEqual([{ canonical: "Acme", label: "organization" }]);
  });

  test("keeps the first occurrence's casing", () => {
    const terms = dedupeDetectedAnonymizationTerms([
      { original: "ACME", label: "organization" },
      { original: "acme", label: "organization" },
    ]);
    expect(terms[0]?.canonical).toBe("ACME");
  });

  test("keeps the same surface form under different labels", () => {
    const terms = dedupeDetectedAnonymizationTerms([
      { original: "Washington", label: "person" },
      { original: "Washington", label: "location" },
    ]);
    expect(terms).toHaveLength(2);
  });
});

describe("excluded canonicals set", () => {
  test("lowercases entries for case-insensitive membership", () => {
    const set = buildExcludedCanonicalsSet([
      { canonical: "Acme Corp" },
      { canonical: "BETA" },
    ]);
    expect(set.has("acme corp")).toBe(true);
    expect(set.has("beta")).toBe(true);
    expect(set.has("Acme Corp")).toBe(false);
  });
});

describe("merged anonymization terms", () => {
  test("is empty while the facet is off-screen", () => {
    expect(
      mergeAnonymizationTerms({
        isAnonymizationActive: false,
        workspaceTerms: [{ canonical: "Acme", label: "organization" }],
        detectedTerms: [{ canonical: "Bob", label: "person" }],
        excludedCanonicals: new Set(),
      }),
    ).toEqual([]);
  });

  test("returns the workspace list unfiltered when nothing is excluded", () => {
    const workspaceTerms = [{ canonical: "Acme", label: "organization" }];
    const merged = mergeAnonymizationTerms({
      isAnonymizationActive: true,
      workspaceTerms,
      detectedTerms: [],
      excludedCanonicals: new Set(),
    });
    expect(merged).toEqual(workspaceTerms);
  });

  test("strips allowlisted catalog terms case-insensitively, keeps detected", () => {
    const merged = mergeAnonymizationTerms({
      isAnonymizationActive: true,
      workspaceTerms: [
        { canonical: "Acme", label: "organization" },
        { canonical: "Beta", label: "organization" },
      ],
      detectedTerms: [{ canonical: "Bob", label: "person" }],
      excludedCanonicals: new Set(["acme"]),
    });
    expect(merged).toEqual([
      { canonical: "Beta", label: "organization" },
      { canonical: "Bob", label: "person" },
    ]);
  });
});

describe("aggregated anonymization matches", () => {
  test("counts matches per canonical and keeps the first label", () => {
    const result = aggregateAnonymizationMatches([
      { canonical: "Acme", label: "organization" },
      { canonical: "Acme", label: "misc" },
      { canonical: "Bob", label: "person" },
    ]);
    expect(result.totalMatches).toBe(3);
    expect(result.countByCanonical.get("Acme")).toBe(2);
    expect(result.countByCanonical.get("Bob")).toBe(1);
    expect(result.labelByCanonical.get("Acme")).toBe("organization");
  });

  test("returns empty maps for no matches", () => {
    const result = aggregateAnonymizationMatches([]);
    expect(result.totalMatches).toBe(0);
    expect(result.countByCanonical.size).toBe(0);
    expect(result.labelByCanonical.size).toBe(0);
  });
});

describe("trailing single-flight coordinator", () => {
  test("coalesces overlapping triggers into one in-flight plus one trailing run", async () => {
    const gates: Gate[] = [];
    let runCalls = 0;
    const trigger = createTrailingSingleFlight({
      run: () => {
        runCalls += 1;
        const g = gate();
        gates.push(g);
        return g.promise;
      },
    });

    trigger();
    expect(runCalls).toBe(1);

    // Three more while the first is still in flight: they must all
    // collapse into a single trailing run, not three.
    trigger();
    trigger();
    trigger();
    await tick();
    expect(runCalls).toBe(1);

    gates[0]?.resolve();
    await tick();
    expect(runCalls).toBe(2);

    gates[1]?.resolve();
    await tick();
    expect(runCalls).toBe(2);
  });

  test("the trailing run re-snapshots, so the latest state wins", async () => {
    const gates: Gate[] = [];
    let live = "a";
    const snapshots: string[] = [];
    const trigger = createTrailingSingleFlight({
      run: () => {
        snapshots.push(live);
        const g = gate();
        gates.push(g);
        return g.promise;
      },
    });

    trigger();
    // Edit lands while the first save is mid-flight.
    live = "b";
    trigger();

    gates[0]?.resolve();
    await tick();
    gates[1]?.resolve();
    await tick();

    expect(snapshots).toEqual(["a", "b"]);
  });

  test("sequential non-overlapping triggers each run", async () => {
    const gates: Gate[] = [];
    let runCalls = 0;
    const trigger = createTrailingSingleFlight({
      run: () => {
        runCalls += 1;
        const g = gate();
        gates.push(g);
        return g.promise;
      },
    });

    trigger();
    gates[0]?.resolve();
    await tick();
    expect(runCalls).toBe(1);

    trigger();
    gates[1]?.resolve();
    await tick();
    expect(runCalls).toBe(2);
  });

  test("an awaiting trigger resolves only after the trailing run it belongs to", async () => {
    const gates: Gate[] = [];
    const trigger = createTrailingSingleFlight({
      run: () => {
        const g = gate();
        gates.push(g);
        return g.promise;
      },
    });

    trigger();
    let flushed = false;
    // Issued while the first run is in flight: it belongs to the
    // trailing run, not the already-snapshotted in-flight run.
    const flush = (async () => {
      await trigger();
      flushed = true;
    })();

    await tick();
    expect(flushed).toBe(false);

    gates[0]?.resolve();
    await tick();
    // In-flight run settled, but the trailing run is only now
    // starting, so the awaiting caller is still pending.
    expect(flushed).toBe(false);

    gates[1]?.resolve();
    await flush;
    expect(flushed).toBe(true);
  });

  test("a failed run reports to onError exactly once and still settles the caller", async () => {
    let errorCount = 0;
    const trigger = createTrailingSingleFlight({
      run: () => Promise.reject(new Error("save failed")),
      onError: () => {
        errorCount += 1;
      },
    });

    // Resolves (does not reject) despite the rejection.
    await trigger();
    expect(errorCount).toBe(1);
  });

  test("a rejection does not abort a queued trailing run", async () => {
    const gates: Gate[] = [];
    let runCalls = 0;
    let errorCount = 0;
    const trigger = createTrailingSingleFlight({
      run: () => {
        runCalls += 1;
        const g = gate();
        gates.push(g);
        return g.promise;
      },
      onError: () => {
        errorCount += 1;
      },
    });

    trigger();
    trigger();

    gates[0]?.reject(new Error("first save failed"));
    await tick();
    expect(errorCount).toBe(1);
    // The trailing run still fires after the in-flight failure.
    expect(runCalls).toBe(2);

    gates[1]?.resolve();
    await tick();
    expect(errorCount).toBe(1);
  });
});
