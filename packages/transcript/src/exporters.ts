import { Result } from "better-result";

import {
  serializeTranscript,
  TranscriptInputError,
  validateTranscript,
} from "./transcript";
import type { TimedText, Transcript } from "./transcript";

const timestamp = (milliseconds: number, separator: "," | ".") => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(milliseconds % 1000).padStart(3, "0")}`;
};

export const exportTxt = (transcript: Transcript) =>
  validateTranscript(transcript).map(({ segments }) =>
    segments
      .map(({ text }) => text.trim())
      .filter(Boolean)
      .join("\n\n"),
  );

type MarkdownOptions = { timestamps?: boolean };

export const exportMarkdown = (
  transcript: Transcript,
  { timestamps = false }: MarkdownOptions = {},
) =>
  validateTranscript(transcript).map(({ segments }) =>
    segments
      .filter(({ text }) => text.trim().length > 0)
      .map(({ text, startMs }) => {
        const paragraph = text
          .trim()
          .replace(/[\\`*_{}[\]()#+.!|<>-]/gu, "\\$&");
        return `${timestamps ? `[${timestamp(startMs, ".")}] ` : ""}${paragraph}`;
      })
      .join("\n\n"),
  );

export const exportJson = serializeTranscript;

type SubtitleOptions = {
  maxLineLength?: number;
  minCueDurationMs?: number;
  maxCueDurationMs?: number;
};

const wrapLines = (text: string, maxLineLength: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const characters = Array.from(word);
    if (characters.length <= maxLineLength) {
      if (
        line.length > 0 &&
        Array.from(line).length + characters.length + 1 > maxLineLength
      ) {
        lines.push(line);
        line = "";
      }
      line += `${line.length > 0 ? " " : ""}${word}`;
      continue;
    }
    if (line.length > 0) {
      lines.push(line);
      line = "";
    }
    for (let offset = 0; offset < characters.length; offset += maxLineLength) {
      const part = characters.slice(offset, offset + maxLineLength).join("");
      if (offset + maxLineLength < characters.length) {
        lines.push(part);
      } else {
        line = part;
      }
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.join("\n");
};

const escapeSubtitleText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type PlanCuesOptions = {
  transcript: Transcript;
  options: SubtitleOptions;
};

const planCues = ({
  transcript,
  options,
}: PlanCuesOptions): Result<TimedText[], TranscriptInputError> => {
  const {
    maxLineLength = 42,
    minCueDurationMs = 1,
    maxCueDurationMs = 7000,
  } = options;
  if (
    ![maxLineLength, minCueDurationMs, maxCueDurationMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    minCueDurationMs > maxCueDurationMs
  ) {
    return Result.err(
      new TranscriptInputError({ message: "Invalid subtitle options" }),
    );
  }
  return validateTranscript(transcript).andThen(({ segments }) => {
    const cues: TimedText[] = [];
    for (const segment of segments) {
      const text = segment.text.trim().replace(/\s+/gu, " ");
      if (text.length === 0) {
        continue;
      }
      const duration = segment.endMs - segment.startMs;
      const count =
        Math.floor(duration / maxCueDurationMs) +
        (duration % maxCueDurationMs > 0 ? 1 : 0);
      if (
        duration < minCueDurationMs ||
        Math.floor(duration / count) < minCueDurationMs
      ) {
        return Result.err(
          new TranscriptInputError({
            message: "Segment cannot satisfy subtitle cue durations",
          }),
        );
      }
      const words = text.trim().split(/\s+/u);
      const splitOnWords = words.length >= count;
      // Attach separators to a text unit so no cue can consist only of whitespace.
      const units = splitOnWords
        ? words
        : Array.from(text.matchAll(/\S\s*/gu), (match) => match[0]);
      if (units.length < count) {
        return Result.err(
          new TranscriptInputError({
            message: "Segment has insufficient text for subtitle cue durations",
          }),
        );
      }
      let unitOffset = 0;
      for (let index = 0; index < count; index += 1) {
        const unitCount = Math.ceil(
          (units.length - unitOffset) / (count - index),
        );
        const part = units
          .slice(unitOffset, unitOffset + unitCount)
          .join(splitOnWords ? " " : "")
          .trim();
        if (part.length === 0) {
          return Result.err(
            new TranscriptInputError({
              message:
                "Segment has insufficient text for subtitle cue durations",
            }),
          );
        }
        cues.push({
          startMs:
            segment.startMs +
            index * Math.floor(duration / count) +
            Math.min(index, duration % count),
          endMs:
            segment.startMs +
            (index + 1) * Math.floor(duration / count) +
            Math.min(index + 1, duration % count),
          text: escapeSubtitleText(wrapLines(part, maxLineLength)),
        });
        unitOffset += unitCount;
      }
    }
    cues.sort((left, right) => left.startMs - right.startMs);
    return Result.ok(cues);
  });
};

/** SRT timestamps are limited to two hour digits; VTT supports longer recordings. */
export const exportSrt = (
  transcript: Transcript,
  options: SubtitleOptions = {},
) =>
  planCues({ transcript, options }).andThen((cues) => {
    if (cues.some(({ endMs }) => endMs >= 360_000_000)) {
      return Result.err(
        new TranscriptInputError({
          message: "SRT timestamps must be below 100 hours",
        }),
      );
    }
    return Result.ok(
      cues
        .map(
          ({ startMs, endMs, text }, index) =>
            `${index + 1}\n${timestamp(startMs, ",")} --> ${timestamp(endMs, ",")}\n${text}\n`,
        )
        .join("\n"),
    );
  });

export const exportVtt = (
  transcript: Transcript,
  options: SubtitleOptions = {},
) =>
  planCues({ transcript, options }).map(
    (cues) =>
      `WEBVTT\n\n${cues
        .map(
          ({ startMs, endMs, text }) =>
            `${timestamp(startMs, ".")} --> ${timestamp(endMs, ".")}\n${text}\n`,
        )
        .join("\n")}`,
  );
