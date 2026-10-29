import { Result } from "better-result";
import * as v from "valibot";

import {
  intervalSchema,
  TranscriptInputError,
  validateTranscript,
} from "./transcript";
import type { Interval, TimedText, Transcript } from "./transcript";

const invalid = (message: string): Result<never, TranscriptInputError> =>
  Result.err(new TranscriptInputError({ message }));
const isMs = (value: number) => Number.isSafeInteger(value) && value >= 0;
const intervalsValid = (intervals: readonly Interval[], durationMs: number) =>
  isMs(durationMs) &&
  intervals.every(
    (item, index) =>
      v.is(intervalSchema, item) &&
      item.endMs > item.startMs &&
      item.endMs <= durationMs &&
      (index === 0 || item.startMs >= (intervals.at(index - 1)?.endMs ?? 0)),
  );

type SilenceOptions = {
  samples: readonly number[];
  sampleIntervalMs: number;
  thresholdDb: number;
  minimumSilenceMs: number;
  paddingMs: number;
};

/** Each sample describes the following fixed-width interval. -Infinity is digital silence. */
export const detectKeptIntervals = ({
  samples,
  sampleIntervalMs,
  thresholdDb,
  minimumSilenceMs,
  paddingMs,
}: SilenceOptions) => {
  const durationMs = samples.length * sampleIntervalMs;
  if (
    !isMs(sampleIntervalMs) ||
    sampleIntervalMs === 0 ||
    !isMs(durationMs) ||
    !Number.isFinite(thresholdDb) ||
    thresholdDb > 0 ||
    !isMs(minimumSilenceMs) ||
    !isMs(paddingMs) ||
    samples.some((sample) => Number.isNaN(sample) || sample > 0)
  ) {
    return invalid("Invalid metering parameters");
  }
  const kept: Interval[] = [];
  let cursor = 0;
  let silenceStart: number | undefined;
  for (let index = 0; index <= samples.length; index += 1) {
    const sample = samples.at(index);
    if (sample !== undefined && sample <= thresholdDb) {
      silenceStart ??= index * sampleIntervalMs;
      continue;
    }
    if (silenceStart === undefined) {
      continue;
    }
    const silenceEnd = index * sampleIntervalMs;
    const removeStart = silenceStart + paddingMs;
    const removeEnd = silenceEnd - paddingMs;
    if (
      silenceEnd - silenceStart >= minimumSilenceMs &&
      removeEnd > removeStart
    ) {
      if (removeStart > cursor) {
        kept.push({ startMs: cursor, endMs: removeStart });
      }
      cursor = removeEnd;
    }
    silenceStart = undefined;
  }
  if (cursor < durationMs) {
    kept.push({ startMs: cursor, endMs: durationMs });
  }
  return Result.ok(kept);
};

type TimeMapSpan = Interval & { trimmedStartMs: number; trimmedEndMs: number };
export type TimeMap = {
  originalDurationMs: number;
  trimmedDurationMs: number;
  spans: readonly TimeMapSpan[];
};

export const createTimeMap = (
  intervals: readonly Interval[],
  originalDurationMs: number,
) => {
  if (!intervalsValid(intervals, originalDurationMs)) {
    return invalid("Invalid kept intervals");
  }
  let cursor = 0;
  const spans = intervals.map(({ startMs, endMs }) => {
    const trimmedStartMs = cursor;
    cursor += endMs - startMs;
    return { startMs, endMs, trimmedStartMs, trimmedEndMs: cursor };
  });
  return Result.ok({ originalDurationMs, trimmedDurationMs: cursor, spans });
};

/** Removed positions have no image; endpoints of kept spans remain mappable. */
export const originalToTrimmed = (map: TimeMap, originalMs: number) => {
  if (!isMs(originalMs) || originalMs > map.originalDurationMs) {
    return invalid("Original time outside timeline");
  }
  const span = map.spans.find(
    ({ startMs, endMs }) => originalMs >= startMs && originalMs <= endMs,
  );
  return Result.ok(
    span ? span.trimmedStartMs + (originalMs - span.startMs) : null,
  );
};

/** At a cut, start chooses the following span and end chooses the preceding span. */
export const trimmedToOriginal = (
  map: TimeMap,
  trimmedMs: number,
  boundary: "start" | "end" = "start",
) => {
  if (!isMs(trimmedMs) || trimmedMs > map.trimmedDurationMs) {
    return invalid("Trimmed time outside timeline");
  }
  const candidates = map.spans.filter(
    ({ trimmedStartMs, trimmedEndMs }) =>
      trimmedMs >= trimmedStartMs && trimmedMs <= trimmedEndMs,
  );
  const span = boundary === "start" ? candidates.at(-1) : candidates.at(0);
  return Result.ok(
    span ? span.startMs + (trimmedMs - span.trimmedStartMs) : null,
  );
};

type RemapOptions = {
  transcript: Transcript;
  map: TimeMap;
  direction: "to-original" | "to-trimmed";
};
export const remapTranscript = ({ transcript, map, direction }: RemapOptions) =>
  validateTranscript(transcript).andThen((value) => {
    const sourceDuration =
      direction === "to-original"
        ? map.trimmedDurationMs
        : map.originalDurationMs;
    if (value.durationMs !== sourceDuration) {
      return invalid("Transcript duration does not match time map");
    }
    const remap = (items: readonly TimedText[]) =>
      items.flatMap((item) => {
        if (direction === "to-original") {
          const startMs = trimmedToOriginal(
            map,
            item.startMs,
            "start",
          ).unwrap();
          const endMs = trimmedToOriginal(
            map,
            item.endMs,
            item.startMs === item.endMs ? "start" : "end",
          ).unwrap();
          return startMs === null || endMs === null
            ? []
            : [{ ...item, startMs, endMs }];
        }
        if (item.startMs === item.endMs) {
          const point = originalToTrimmed(map, item.startMs).unwrap();
          return point === null
            ? []
            : [{ ...item, startMs: point, endMs: point }];
        }
        const intersections = map.spans.filter(
          (span) => span.endMs > item.startMs && span.startMs < item.endMs,
        );
        const first = intersections.at(0);
        const last = intersections.at(-1);
        if (!first || !last) {
          return [];
        }
        return [
          {
            ...item,
            startMs:
              first.trimmedStartMs + Math.max(item.startMs - first.startMs, 0),
            endMs: last.trimmedEndMs - Math.max(last.endMs - item.endMs, 0),
          },
        ];
      });
    return validateTranscript({
      ...value,
      durationMs:
        direction === "to-original"
          ? map.originalDurationMs
          : map.trimmedDurationMs,
      segments: remap(value.segments),
      ...(value.words === undefined ? {} : { words: remap(value.words) }),
    });
  });

type ChunkOptions = {
  durationMs: number;
  maxDurationMs: number;
  maxBytes: number;
  bitrateBitsPerSecond: number;
  silences?: readonly Interval[];
};

/** Byte limits cover the bitrate estimate; callers must account for container overhead. */
export const planChunks = ({
  durationMs,
  maxDurationMs,
  maxBytes,
  bitrateBitsPerSecond,
  silences = [],
}: ChunkOptions) => {
  if (
    !intervalsValid(silences, durationMs) ||
    !isMs(maxDurationMs) ||
    maxDurationMs === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(bitrateBitsPerSecond) ||
    bitrateBitsPerSecond <= 0
  ) {
    return invalid("Invalid chunk parameters");
  }
  let capacityMs = Math.min(
    maxDurationMs,
    Math.floor((maxBytes / bitrateBitsPerSecond) * 8000),
    Math.floor(Number.MAX_SAFE_INTEGER / bitrateBitsPerSecond),
  );
  // Keep the byte estimate exact even near the safe integer boundary.
  while (Math.ceil((capacityMs * bitrateBitsPerSecond) / 8000) > maxBytes) {
    capacityMs -= 1;
  }
  if (capacityMs < 1) {
    return invalid("Chunk limits cannot fit one millisecond");
  }
  const chunks: Interval[] = [];
  let cursor = 0;
  let silenceIndex = 0;
  while (cursor < durationMs) {
    const limit = Math.min(
      durationMs,
      cursor + Math.min(capacityMs, durationMs - cursor),
    );
    let boundary = limit;
    // Only the last half of a chunk is considered, keeping progress bounded.
    while (silenceIndex < silences.length) {
      const silence = silences.at(silenceIndex);
      if (!silence || silence.startMs > limit) {
        break;
      }
      if (limit < durationMs && silence.endMs >= cursor + capacityMs / 2) {
        const preferred = Math.min(
          limit,
          silence.startMs + Math.floor((silence.endMs - silence.startMs) / 2),
        );
        if (preferred > cursor + capacityMs / 2) {
          boundary = preferred;
        }
      }
      if (silence.endMs > limit) {
        break;
      }
      silenceIndex += 1;
    }
    chunks.push({ startMs: cursor, endMs: boundary });
    cursor = boundary;
  }
  return Result.ok(chunks);
};

export type TranscriptChunk = { offsetMs: number; transcript: Transcript };
export const mergeTranscripts = (chunks: readonly TranscriptChunk[]) => {
  const segments: TimedText[] = [];
  const words: TimedText[] = [];
  let durationMs = 0;
  let hasWords = false;
  const languages = new Set<string>();
  const models = new Set<string>();
  for (const chunk of chunks) {
    const checked = validateTranscript(chunk.transcript);
    if (checked.isErr()) {
      return checked;
    }
    const { transcript, offsetMs } = chunk;
    if (!isMs(offsetMs) || !isMs(offsetMs + transcript.durationMs)) {
      return invalid("Invalid chunk offset");
    }
    durationMs = Math.max(durationMs, offsetMs + transcript.durationMs);
    for (const segment of transcript.segments) {
      segments.push({
        ...segment,
        startMs: segment.startMs + offsetMs,
        endMs: segment.endMs + offsetMs,
      });
    }
    if (transcript.words !== undefined) {
      hasWords = true;
      for (const word of transcript.words) {
        words.push({
          ...word,
          startMs: word.startMs + offsetMs,
          endMs: word.endMs + offsetMs,
        });
      }
    }
    if (transcript.language !== undefined) {
      languages.add(transcript.language);
    }
    if (transcript.model !== undefined) {
      models.add(transcript.model);
    }
  }
  const order = (a: TimedText, b: TimedText) => a.startMs - b.startMs;
  return validateTranscript({
    durationMs,
    segments: segments.sort(order),
    ...(hasWords ? { words: words.sort(order) } : {}),
    ...(languages.size === 1 ? { language: [...languages][0] } : {}),
    ...(models.size === 1 ? { model: [...models][0] } : {}),
  });
};
