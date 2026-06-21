import { describe, expect, test } from "bun:test";

import {
  aggregateAnonymizationMatches,
  buildAnonymizationDetectionKey,
  buildExcludedCanonicalsSet,
  decideAnonymizationDetectionRun,
  dedupeDetectedAnonymizationTerms,
  mergeAnonymizationTerms,
  resolveCheckpointAutosaveStatus,
} from "./docx-edit-mode.logic";

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
