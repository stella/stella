import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  clusterActivitySignals,
  suggestionFingerprint,
  type ActivitySignal,
} from "./cluster";

const DATE = "2026-09-18";
const DAY_START_MS = Date.UTC(2026, 8, 18);
const MS_PER_MINUTE = 60_000;

const signalArbitrary = fc
  .record({
    minute: fc.integer({ min: 0, max: 24 * 60 - 1 }),
    second: fc.integer({ min: 0, max: 59 }),
    ordinal: fc.nat(),
    evidence: fc.oneof(
      fc.record({
        type: fc.constant("chat_thread" as const),
        id: fc.constantFrom("thread-a", "thread-b", "thread-c"),
        title: fc.constantFrom("Drafting", "Research", "Call notes"),
      }),
      fc.record({
        type: fc.constant("resource" as const),
        id: fc.constantFrom("doc-1", "doc-2", "task-1"),
        resourceType: fc.constantFrom("entity", "work_obligation"),
        name: fc.option(fc.constantFrom("Lease", "Memo", "Filing"), {
          nil: null,
        }),
        action: fc.constantFrom("create", "update", "download"),
      }),
    ),
  })
  .map(({ minute, second, ordinal, evidence }): ActivitySignal => ({
    at: new Date(DAY_START_MS + minute * MS_PER_MINUTE + second * 1000),
    key: `signal:${ordinal}:${minute}:${second}`,
    evidence,
  }));

const signalsArbitrary = fc.uniqueArray(signalArbitrary, {
  selector: (signal) => signal.key,
  maxLength: 80,
});

const optionsArbitrary = fc.record({
  mergeGapMinutes: fc.integer({ min: 1, max: 120 }),
  tailMinutes: fc.integer({ min: 0, max: 30 }),
});

const DRAFTING_THREAD: ActivitySignal["evidence"] = {
  type: "chat_thread",
  id: "thread-a",
  title: "Drafting",
};

const signalAt = (
  minutes: number,
  key: string,
  evidence?: ActivitySignal["evidence"],
): ActivitySignal => ({
  at: new Date(DAY_START_MS + minutes * MS_PER_MINUTE),
  key,
  evidence: evidence ?? DRAFTING_THREAD,
});

describe("clusterActivitySignals", () => {
  test("INVARIANT: clusters are ordered, disjoint, and separated by more than the merge gap", () => {
    fc.assert(
      fc.property(signalsArbitrary, optionsArbitrary, (signals, options) => {
        const clusters = clusterActivitySignals({
          date: DATE,
          signals,
          ...options,
        });
        const gapMs = options.mergeGapMinutes * MS_PER_MINUTE;
        for (let index = 1; index < clusters.length; index += 1) {
          const previous = clusters[index - 1]!;
          const current = clusters[index]!;
          expect(
            current.startedAt.getTime() - previous.endedAt.getTime(),
          ).toBeGreaterThan(gapMs);
        }
        for (const cluster of clusters) {
          expect(cluster.endedAt.getTime()).toBeGreaterThanOrEqual(
            cluster.startedAt.getTime(),
          );
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("INVARIANT: every signal lands in exactly one cluster and durations cover the span plus the tail", () => {
    fc.assert(
      fc.property(signalsArbitrary, optionsArbitrary, (signals, options) => {
        const clusters = clusterActivitySignals({
          date: DATE,
          signals,
          ...options,
        });
        const counted = clusters.reduce(
          (sum, cluster) => sum + cluster.signalCount,
          0,
        );
        expect(counted).toBe(signals.length);
        for (const cluster of clusters) {
          const spanMinutes = Math.ceil(
            (cluster.endedAt.getTime() - cluster.startedAt.getTime()) /
              MS_PER_MINUTE,
          );
          expect(cluster.durationMinutes).toBe(
            spanMinutes + options.tailMinutes,
          );
          const messageCount = cluster.evidence.reduce(
            (sum, item) =>
              sum + (item.type === "chat_thread" ? item.messageCount : 0),
            0,
          );
          expect(messageCount).toBeLessThanOrEqual(cluster.signalCount);
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("INVARIANT: fingerprints are unique per day and independent of input order", () => {
    fc.assert(
      fc.property(signalsArbitrary, optionsArbitrary, (signals, options) => {
        const forward = clusterActivitySignals({
          date: DATE,
          signals,
          ...options,
        });
        const reversed = clusterActivitySignals({
          date: DATE,
          signals: signals.toReversed(),
          ...options,
        });
        expect(reversed.map((cluster) => cluster.fingerprint)).toEqual(
          forward.map((cluster) => cluster.fingerprint),
        );
        expect(
          new Set(forward.map((cluster) => cluster.fingerprint)).size,
        ).toBe(forward.length);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("INVARIANT: a later signal that extends a cluster keeps its fingerprint", () => {
    fc.assert(
      fc.property(
        signalsArbitrary.filter((signals) => signals.length > 0),
        optionsArbitrary,
        fc.integer({ min: 0, max: 24 * 60 - 1 }),
        (signals, options, extraMinute) => {
          const before = clusterActivitySignals({
            date: DATE,
            signals,
            ...options,
          });
          const extra = signalAt(extraMinute, "signal:extra");
          const after = clusterActivitySignals({
            date: DATE,
            signals: [...signals, extra],
            ...options,
          });
          // The extra signal can only bridge clusters or start a new one;
          // whichever cluster it joins, that cluster's earliest signal (and
          // so its fingerprint) is unchanged unless the extra signal is the
          // new earliest.
          const survivingFingerprints = new Set(
            after.map((cluster) => cluster.fingerprint),
          );
          for (const cluster of before) {
            const extraIsEarlier =
              extra.at.getTime() < cluster.startedAt.getTime();
            if (!extraIsEarlier) {
              const stillFirst = after.some(
                (candidate) =>
                  candidate.fingerprint === cluster.fingerprint &&
                  candidate.startedAt.getTime() === cluster.startedAt.getTime(),
              );
              const merged = after.some(
                (candidate) =>
                  candidate.startedAt.getTime() < cluster.startedAt.getTime() &&
                  candidate.endedAt.getTime() >= cluster.endedAt.getTime(),
              );
              expect(stillFirst || merged).toBe(true);
            }
          }
          expect(survivingFingerprints.size).toBe(after.length);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("merges signals within the gap and splits across it", () => {
    const clusters = clusterActivitySignals({
      date: DATE,
      signals: [
        signalAt(0, "a"),
        signalAt(10, "b"),
        signalAt(26, "c"),
        signalAt(30, "d", {
          type: "resource",
          id: "doc-1",
          resourceType: "entity",
          name: "Lease",
          action: "update",
        }),
      ],
      mergeGapMinutes: 15,
      tailMinutes: 5,
    });
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      durationMinutes: 15,
      signalCount: 2,
      evidence: [
        {
          type: "chat_thread",
          id: "thread-a",
          title: "Drafting",
          messageCount: 2,
        },
      ],
    });
    expect(clusters[1]).toMatchObject({
      durationMinutes: 9,
      signalCount: 2,
      evidence: [
        { type: "chat_thread", id: "thread-a", messageCount: 1 },
        {
          type: "resource",
          id: "doc-1",
          resourceType: "entity",
          name: "Lease",
          actions: ["update"],
        },
      ],
    });
    expect(clusters[0]?.fingerprint).toBe(suggestionFingerprint(DATE, "a"));
  });

  test("a single signal yields the tail as its duration", () => {
    const [only] = clusterActivitySignals({
      date: DATE,
      signals: [signalAt(540, "solo")],
      mergeGapMinutes: 15,
      tailMinutes: 5,
    });
    expect(only?.durationMinutes).toBe(5);
    expect(only?.signalCount).toBe(1);
  });

  test("folds repeated resource actions and backfills a missing name", () => {
    const [only] = clusterActivitySignals({
      date: DATE,
      signals: [
        signalAt(0, "a", {
          type: "resource",
          id: "doc-1",
          resourceType: "entity",
          name: null,
          action: "update",
        }),
        signalAt(1, "b", {
          type: "resource",
          id: "doc-1",
          resourceType: "entity",
          name: "Lease",
          action: "update",
        }),
        signalAt(2, "c", {
          type: "resource",
          id: "doc-1",
          resourceType: "entity",
          name: "Lease",
          action: "download",
        }),
      ],
      mergeGapMinutes: 15,
      tailMinutes: 0,
    });
    expect(only?.evidence).toEqual([
      {
        type: "resource",
        id: "doc-1",
        resourceType: "entity",
        name: "Lease",
        actions: ["update", "download"],
      },
    ]);
  });
});
