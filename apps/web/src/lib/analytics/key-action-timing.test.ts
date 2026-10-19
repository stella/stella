import { describe, expect, mock, test } from "bun:test";

import { createDocumentOpenTiming } from "@/lib/analytics/document-open-timing";
import {
  KEY_ACTION_DURATION_BUCKETS_MS,
  KEY_ACTION_DURATION_OVERFLOW_MS,
  keyActionDurationBucket,
  startKeyActionTimer,
} from "@/lib/analytics/key-action-timing";
import { createSearchTiming } from "@/lib/analytics/search-timing";
import type { KeyActionTiming } from "@/lib/analytics/types";

// Exactly these fields: a timing names the action, where it ran and a coarse
// duration, never the document, query or thread it touched.
const TIMING_KEYS = ["action", "durationBucketMs", "surface"];

const recorder = () => {
  const captured: KeyActionTiming[] = [];
  const analytics = {
    captureKeyActionTiming: mock((timing: KeyActionTiming) => {
      captured.push(timing);
    }),
  };
  return { analytics, captured };
};

const manualClock = () => {
  let time = 1000;
  return {
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
};

describe("keyActionDurationBucket", () => {
  test("reports the smallest bound a duration fits under", () => {
    expect(keyActionDurationBucket(0)).toBe(100);
    for (const [index, bound] of KEY_ACTION_DURATION_BUCKETS_MS.entries()) {
      expect(keyActionDurationBucket(bound)).toBe(bound);
      expect(keyActionDurationBucket(bound + 0.1)).toBe(
        KEY_ACTION_DURATION_BUCKETS_MS[index + 1] ??
          KEY_ACTION_DURATION_OVERFLOW_MS,
      );
    }
  });

  test("keeps the ladder strictly increasing and the overflow above it", () => {
    const bounds = [
      ...KEY_ACTION_DURATION_BUCKETS_MS,
      KEY_ACTION_DURATION_OVERFLOW_MS,
    ];
    for (let index = 1; index < bounds.length; index += 1) {
      expect(bounds[index]).toBeGreaterThan(bounds[index - 1] ?? 0);
    }
  });

  test("refuses readings no clock produces", () => {
    expect(keyActionDurationBucket(-1)).toBeUndefined();
    expect(keyActionDurationBucket(Number.NaN)).toBeUndefined();
    expect(keyActionDurationBucket(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("startKeyActionTimer", () => {
  test("reports one bucketed duration however often it finishes", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timer = startKeyActionTimer(
      analytics,
      { action: "document-save", surface: "inspector" },
      { now: clock.now },
    );
    clock.advance(420);
    timer.finish();
    timer.finish();

    expect(captured).toEqual([
      { action: "document-save", durationBucketMs: 500, surface: "inspector" },
    ]);
    expect(Object.keys(captured[0] ?? {}).toSorted()).toEqual(TIMING_KEYS);
  });

  test("a mark fixes the end that a later finish reports", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timer = startKeyActionTimer(
      analytics,
      { action: "chat-first-token", surface: "chat-thread" },
      { now: clock.now },
    );
    clock.advance(200);
    timer.mark();
    clock.advance(9000);
    timer.mark();
    expect(captured).toEqual([]);
    timer.finish();

    expect(captured.map((entry) => entry.durationBucketMs)).toEqual([250]);
  });

  test("reports nothing once cancelled", () => {
    const { analytics, captured } = recorder();
    const timer = startKeyActionTimer(analytics, {
      action: "document-save",
      surface: "full-view",
    });
    timer.cancel();
    timer.finish();

    expect(captured).toEqual([]);
  });

  test("drops a finish that comes after the abandon limit", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timer = startKeyActionTimer(
      analytics,
      { action: "search-results", surface: "case-law" },
      { abandonAfterMs: 1000, now: clock.now },
    );
    clock.advance(1001);
    timer.finish();

    expect(captured).toEqual([]);
  });
});

describe("document open timing", () => {
  test("pairs a click with its editor becoming ready on the same surface", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timing = createDocumentOpenTiming(() => analytics, clock.now);

    timing.requested("field_secret_1", "inspector");
    clock.advance(1200);
    timing.editorReady("field_secret_1", "full-view");
    timing.editorReady("field_other", "inspector");
    expect(captured).toEqual([]);

    timing.editorReady("field_secret_1", "inspector");
    timing.editorReady("field_secret_1", "inspector");

    expect(captured).toEqual([
      { action: "document-open", durationBucketMs: 1500, surface: "inspector" },
    ]);
    expect(Object.keys(captured[0] ?? {}).toSorted()).toEqual(TIMING_KEYS);
    expect(JSON.stringify(captured)).not.toContain("field_secret_1");
  });

  test("a reopen restarts the clock and a stale open reports nothing", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timing = createDocumentOpenTiming(() => analytics, clock.now);

    timing.requested("field_1", "inspector");
    clock.advance(5000);
    timing.requested("field_1", "inspector");
    clock.advance(200);
    timing.editorReady("field_1", "inspector");
    expect(captured.map((entry) => entry.durationBucketMs)).toEqual([250]);

    timing.requested("field_2", "full-view");
    clock.advance(61_000);
    timing.editorReady("field_2", "full-view");
    expect(captured).toHaveLength(1);
  });

  test("forgets opens no editor finished once they are stale", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timing = createDocumentOpenTiming(() => analytics, clock.now);

    timing.requested("field_pdf", "inspector");
    clock.advance(61_000);
    // A later open prunes the stale one, so its ready signal is ignored even
    // though it now comes quickly after.
    timing.requested("field_docx", "inspector");
    timing.editorReady("field_pdf", "inspector");

    expect(captured).toEqual([]);
  });
});

describe("search timing", () => {
  test("ends at the results of the submitted query only", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timing = createSearchTiming(() => analytics, clock.now);

    timing.requested("legislation", "  secret query ");
    clock.advance(800);
    timing.resultsShown("legislation", "previous query");
    timing.resultsShown("case-law", "secret query");
    expect(captured).toEqual([]);

    timing.resultsShown("legislation", "secret query");
    timing.resultsShown("legislation", "secret query");

    expect(captured).toEqual([
      {
        action: "search-results",
        durationBucketMs: 1000,
        surface: "legislation",
      },
    ]);
    expect(Object.keys(captured[0] ?? {}).toSorted()).toEqual(TIMING_KEYS);
    expect(JSON.stringify(captured)).not.toContain("secret");
  });

  test("a newer query replaces the pending one and a cleared query times nothing", () => {
    const { analytics, captured } = recorder();
    const clock = manualClock();
    const timing = createSearchTiming(() => analytics, clock.now);

    timing.requested("case-law", "first");
    clock.advance(100);
    timing.requested("case-law", "second");
    timing.resultsShown("case-law", "first");
    clock.advance(200);
    timing.resultsShown("case-law", "second");
    expect(captured.map((entry) => entry.durationBucketMs)).toEqual([250]);

    timing.requested("case-law", "   ");
    timing.resultsShown("case-law", "");
    expect(captured).toHaveLength(1);
  });
});
