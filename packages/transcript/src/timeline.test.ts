import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createTimeMap,
  detectKeptIntervals,
  mergeTranscripts,
  originalToTrimmed,
  planChunks,
  remapTranscript,
  trimmedToOriginal,
} from "./timeline";
import {
  parseTranscript,
  serializeTranscript,
  validateTranscript,
} from "./transcript";

const levels = fc.array(fc.boolean(), { maxLength: 100 });

test("silence keeps ordered bounded intervals and every padded speech sample", () => {
  assertProperty(
    "silence keeps ordered bounded intervals and every padded speech sample",
    fc.property(
      levels,
      fc.integer({ min: 0, max: 300 }),
      fc.integer({ min: 0, max: 100 }),
      (speech, minimumSilenceMs, paddingMs) => {
        const intervals = detectKeptIntervals({
          samples: speech.map((active) => (active ? -10 : -80)),
          sampleIntervalMs: 10,
          thresholdDb: -40,
          minimumSilenceMs,
          paddingMs,
        }).unwrap();
        let previousEnd = 0;
        for (const interval of intervals) {
          expect(interval.startMs).toBeGreaterThanOrEqual(previousEnd);
          expect(interval.endMs).toBeGreaterThan(interval.startMs);
          expect(interval.endMs).toBeLessThanOrEqual(speech.length * 10);
          previousEnd = interval.endMs;
        }
        for (let sample = 0; sample < speech.length; sample += 1) {
          if (!speech.at(sample)) {
            continue;
          }
          const start = Math.max(0, sample * 10 - paddingMs);
          const end = Math.min(
            speech.length * 10,
            (sample + 1) * 10 + paddingMs,
          );
          expect(
            intervals.some(
              (interval) => interval.startMs <= start && interval.endMs >= end,
            ),
          ).toBe(true);
        }
      },
    ),
  );
});

test("kept timeline positions round trip away from ambiguous cut endpoints", () => {
  assertProperty(
    "kept timeline positions round trip away from ambiguous cut endpoints",
    fc.property(levels, (speech) => {
      const kept = detectKeptIntervals({
        samples: speech.map((active) => (active ? -5 : -Infinity)),
        sampleIntervalMs: 10,
        thresholdDb: -30,
        minimumSilenceMs: 10,
        paddingMs: 0,
      }).unwrap();
      const map = createTimeMap(kept, speech.length * 10).unwrap();
      for (const interval of kept) {
        const original = interval.startMs + 1;
        const trimmed = originalToTrimmed(map, original).unwrap();
        expect(trimmed).not.toBeNull();
        if (trimmed === null) {
          return;
        }
        expect(trimmedToOriginal(map, trimmed).unwrap()).toBe(original);
      }
      for (let trimmed = 0; trimmed <= map.trimmedDurationMs; trimmed += 1) {
        const original = trimmedToOriginal(map, trimmed).unwrap();
        if (original === null) {
          expect(kept).toEqual([]);
          continue;
        }
        expect(originalToTrimmed(map, original).unwrap()).toBe(trimmed);
      }
    }),
  );
});

test("chunks cover the recording exactly within both caller limits", () => {
  assertProperty(
    "chunks cover the recording exactly within both caller limits",
    fc.property(
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 8000 }),
      (durationMs, maxDurationMs, maxBytes, bitrateBitsPerSecond) => {
        const silences =
          durationMs > 4
            ? [
                {
                  startMs: Math.floor(durationMs / 3),
                  endMs: Math.floor((durationMs * 2) / 3),
                },
              ]
            : [];
        const chunks = planChunks({
          durationMs,
          maxDurationMs,
          maxBytes,
          bitrateBitsPerSecond,
          silences,
        }).unwrap();
        let cursor = 0;
        for (const chunk of chunks) {
          expect(chunk.startMs).toBe(cursor);
          const length = chunk.endMs - chunk.startMs;
          expect(length).toBeGreaterThan(0);
          expect(length).toBeLessThanOrEqual(maxDurationMs);
          expect(
            Math.ceil((length * bitrateBitsPerSecond) / 8000),
          ).toBeLessThanOrEqual(maxBytes);
          cursor = chunk.endMs;
        }
        expect(cursor).toBe(durationMs);
      },
    ),
  );
});

test("mapping preserves exact milliseconds near the safe integer boundary", () => {
  assertProperty(
    "mapping preserves exact milliseconds near the safe integer boundary",
    fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 1, max: 1000 }),
      (shift, offset) => {
        const firstLength = 4_000_000_000_000_000 + shift;
        const secondStart = 8_000_000_000_000_000 + shift;
        const map = createTimeMap(
          [
            { startMs: 0, endMs: firstLength },
            { startMs: secondStart, endMs: secondStart + 1001 },
          ],
          secondStart + 1001,
        ).unwrap();
        const original = secondStart + offset;
        const trimmed = firstLength + offset;
        expect(originalToTrimmed(map, original).unwrap()).toBe(trimmed);
        expect(trimmedToOriginal(map, trimmed).unwrap()).toBe(original);
        expect(trimmedToOriginal(map, trimmed, "end").unwrap()).toBe(original);
      },
    ),
  );
});

test("remapping preserves point cues at every kept endpoint and cut seam", () => {
  assertProperty(
    "remapping preserves point cues at every kept endpoint and cut seam",
    fc.property(levels, (speech) => {
      const kept = detectKeptIntervals({
        samples: speech.map((active) => (active ? -5 : -Infinity)),
        sampleIntervalMs: 10,
        thresholdDb: -30,
        minimumSilenceMs: 10,
        paddingMs: 0,
      }).unwrap();
      const map = createTimeMap(kept, speech.length * 10).unwrap();
      const originalPoints = map.spans.flatMap((span, index) => [
        {
          startMs: span.startMs,
          endMs: span.startMs,
          text: `Žofia ${index} začátek`,
        },
        {
          startMs: span.endMs,
          endMs: span.endMs,
          text: `Žofia ${index} konec`,
        },
      ]);
      const expected = map.spans.flatMap((span, index) => [
        {
          startMs: span.trimmedStartMs,
          endMs: span.trimmedStartMs,
          text: `Žofia ${index} začátek`,
        },
        {
          startMs: span.trimmedEndMs,
          endMs: span.trimmedEndMs,
          text: `Žofia ${index} konec`,
        },
      ]);
      const trimmed = remapTranscript({
        transcript: {
          durationMs: map.originalDurationMs,
          segments: originalPoints,
          words: originalPoints,
        },
        map,
        direction: "to-trimmed",
      }).unwrap();
      expect(trimmed.segments).toEqual(expected);
      expect(trimmed.words).toEqual(expected);
      const restored = remapTranscript({
        transcript: trimmed,
        map,
        direction: "to-original",
      }).unwrap();
      expect(restored.segments).toHaveLength(originalPoints.length);
      expect(restored.words).toHaveLength(originalPoints.length);
      expect(
        remapTranscript({
          transcript: restored,
          map,
          direction: "to-trimmed",
        }).unwrap(),
      ).toEqual(trimmed);
    }),
  );
});

test("large chunk plans preserve coverage and exact byte bounds", () => {
  assertProperty(
    "large chunk plans preserve coverage and exact byte bounds",
    fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 8000, max: 8016 }),
      (distance, bitrateBitsPerSecond) => {
        const durationMs = Number.MAX_SAFE_INTEGER - distance;
        const maxBytes = Number.MAX_SAFE_INTEGER - distance;
        const chunks = planChunks({
          durationMs,
          maxDurationMs: durationMs,
          maxBytes,
          bitrateBitsPerSecond,
        }).unwrap();
        let cursor = 0;
        for (const chunk of chunks) {
          expect(chunk.startMs).toBe(cursor);
          const length = chunk.endMs - chunk.startMs;
          expect(length).toBeGreaterThan(0);
          const exactBytes =
            (BigInt(length) * BigInt(bitrateBitsPerSecond) + 7999n) / 8000n;
          expect(exactBytes <= BigInt(maxBytes)).toBe(true);
          expect(
            Math.ceil((length * bitrateBitsPerSecond) / 8000),
          ).toBeLessThanOrEqual(maxBytes);
          cursor = chunk.endMs;
        }
        expect(cursor).toBe(durationMs);
      },
    ),
    { numRuns: 20 },
  );
});

test("merge sorts arbitrary offsets stably and preserves partial word coverage", () => {
  assertProperty(
    "merge sorts arbitrary offsets stably and preserves partial word coverage",
    fc.property(
      fc.array(
        fc.record({
          offsetMs: fc.integer({ min: 0, max: 10_000 }),
          hasWords: fc.boolean(),
        }),
        { maxLength: 50 },
      ),
      (items) => {
        const merged = mergeTranscripts(
          items.map(({ offsetMs, hasWords }, index) => ({
            offsetMs,
            transcript: {
              durationMs: 100,
              language: "cs",
              model: "recorded",
              segments: [{ startMs: 0, endMs: 100, text: String(index) }],
              ...(hasWords
                ? { words: [{ startMs: 0, endMs: 50, text: "Žofii" }] }
                : {}),
            },
          })),
        ).unwrap();
        const expected = items
          .map(({ offsetMs }, index) => ({ offsetMs, index }))
          .toSorted((a, b) => a.offsetMs - b.offsetMs);
        expect(merged.segments.map(({ text }) => text)).toEqual(
          expected.map(({ index }) => String(index)),
        );
        expect(merged.words?.length ?? 0).toBe(
          items.filter(({ hasWords }) => hasWords).length,
        );
        expect(validateTranscript(merged).isOk()).toBe(true);
      },
    ),
  );
});

test("silence threshold minimum and padding include exact boundaries", () => {
  expect(
    detectKeptIntervals({
      samples: [-10, -40, -80, -10],
      sampleIntervalMs: 100,
      thresholdDb: -40,
      minimumSilenceMs: 200,
      paddingMs: 50,
    }).unwrap(),
  ).toEqual([
    { startMs: 0, endMs: 150 },
    { startMs: 250, endMs: 400 },
  ]);
  expect(
    detectKeptIntervals({
      samples: [-Infinity],
      sampleIntervalMs: 100,
      thresholdDb: -40,
      minimumSilenceMs: 100,
      paddingMs: 0,
    }).unwrap(),
  ).toEqual([]);
  expect(
    detectKeptIntervals({
      samples: [],
      sampleIntervalMs: 100,
      thresholdDb: -40,
      minimumSilenceMs: 0,
      paddingMs: 0,
    }).unwrap(),
  ).toEqual([]);
  expect(
    detectKeptIntervals({
      samples: [-80],
      sampleIntervalMs: 100,
      thresholdDb: -40,
      minimumSilenceMs: 100,
      paddingMs: 60,
    }).unwrap(),
  ).toEqual([{ startMs: 0, endMs: 100 }]);
});

test("mapping distinguishes cut sides and drops removed text", () => {
  const map = createTimeMap(
    [
      { startMs: 100, endMs: 200 },
      { startMs: 400, endMs: 500 },
    ],
    600,
  ).unwrap();
  expect(originalToTrimmed(map, 300).unwrap()).toBeNull();
  expect(trimmedToOriginal(map, 100).unwrap()).toBe(400);
  expect(trimmedToOriginal(map, 100, "end").unwrap()).toBe(200);
  const trimmed = remapTranscript({
    transcript: {
      durationMs: 600,
      segments: [
        { startMs: 110, endMs: 490, text: "Žofii Červeňové" },
        { startMs: 250, endMs: 300, text: "ticho" },
      ],
    },
    map,
    direction: "to-trimmed",
  }).unwrap();
  expect(trimmed.segments).toEqual([
    { startMs: 10, endMs: 190, text: "Žofii Červeňové" },
  ]);
  expect(
    remapTranscript({
      transcript: trimmed,
      map,
      direction: "to-original",
    }).unwrap().segments,
  ).toEqual([{ startMs: 110, endMs: 490, text: "Žofii Červeňové" }]);
});

test("planner prefers silence and handles zero duration", () => {
  expect(
    planChunks({
      durationMs: 2000,
      maxDurationMs: 1000,
      maxBytes: 1000,
      bitrateBitsPerSecond: 8000,
      silences: [{ startMs: 700, endMs: 900 }],
    }).unwrap(),
  ).toEqual([
    { startMs: 0, endMs: 800 },
    { startMs: 800, endMs: 1800 },
    { startMs: 1800, endMs: 2000 },
  ]);
  expect(
    planChunks({
      durationMs: 0,
      maxDurationMs: 1,
      maxBytes: 1,
      bitrateBitsPerSecond: 8000,
    }).unwrap(),
  ).toEqual([]);
});

test("invalid timeline inputs produce typed errors", () => {
  for (const sample of [Number.NaN, Infinity, 1]) {
    expect(
      detectKeptIntervals({
        samples: [sample],
        sampleIntervalMs: 10,
        thresholdDb: -30,
        minimumSilenceMs: 10,
        paddingMs: 0,
      }).isErr(),
    ).toBe(true);
  }
  for (const interval of [
    { startMs: 2, endMs: 1 },
    { startMs: -1, endMs: 1 },
    { startMs: 0, endMs: 101 },
    { startMs: 0, endMs: 0 },
  ]) {
    expect(createTimeMap([interval], 100).isErr()).toBe(true);
  }
  expect(
    createTimeMap(
      [
        { startMs: 0, endMs: 50 },
        { startMs: 25, endMs: 75 },
      ],
      100,
    ).isErr(),
  ).toBe(true);
  const empty = createTimeMap([], 0).unwrap();
  expect(originalToTrimmed(empty, 1).isErr()).toBe(true);
  expect(trimmedToOriginal(empty, -1).isErr()).toBe(true);
  expect(
    remapTranscript({
      transcript: { durationMs: 1, segments: [] },
      map: empty,
      direction: "to-original",
    }).isErr(),
  ).toBe(true);
  expect(
    planChunks({
      durationMs: 1,
      maxDurationMs: 1,
      maxBytes: 1,
      bitrateBitsPerSecond: 100_000,
    }).isErr(),
  ).toBe(true);
  expect(
    planChunks({
      durationMs: 1,
      maxDurationMs: 0,
      maxBytes: 1,
      bitrateBitsPerSecond: 1,
    }).isErr(),
  ).toBe(true);
  expect(
    mergeTranscripts([
      { offsetMs: -1, transcript: { durationMs: 0, segments: [] } },
    ]).isErr(),
  ).toBe(true);
});

test("canonical JSON round trips arbitrary valid text and rejects invalid boundaries", () => {
  assertProperty(
    "canonical JSON round trips arbitrary valid text and rejects invalid boundaries",
    fc.property(fc.string(), (text) => {
      const transcript = {
        durationMs: 100,
        segments: [{ startMs: 0, endMs: 100, text }],
        language: "sk",
      };
      expect(
        parseTranscript(serializeTranscript(transcript).unwrap()).unwrap(),
      ).toEqual(transcript);
    }),
  );
  for (const json of [
    "{",
    '{"version":2,"transcript":{"durationMs":0,"segments":[]}}',
    '{"version":1,"transcript":{"durationMs":0,"segments":[],"extra":true}}',
  ]) {
    expect(parseTranscript(json).isErr()).toBe(true);
  }
  for (const transcript of [
    { durationMs: -1, segments: [] },
    { durationMs: Infinity, segments: [] },
    { durationMs: 10, segments: [{ startMs: 0, endMs: 11, text: "text" }] },
    { durationMs: 10, segments: [{ startMs: 2, endMs: 1, text: "text" }] },
    {
      durationMs: 10,
      segments: [
        { startMs: 5, endMs: 6, text: "a" },
        { startMs: 0, endMs: 1, text: "b" },
      ],
    },
  ]) {
    expect(validateTranscript(transcript).isErr()).toBe(true);
  }
});
