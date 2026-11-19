import { describe, expect, test } from "bun:test";

import {
  formatTimestamp,
  isFileChoice,
  isFinished,
  isPieceText,
  isRecordingModel,
  isTranscribeSnapshot,
  paragraphsOf,
  progressShare,
  recordingTitle,
  transcriptText,
  wholeMinutes,
} from "../src/transcribe/transcribe-logic";
import type { PieceText } from "../src/transcribe/transcribe-logic";

const piece = (
  index: number,
  startSeconds: number,
  text: string,
  pauseBeforeMs = 300,
): PieceText => ({
  job: 1,
  index,
  startMs: startSeconds * 1000,
  endMs: (startSeconds + 20) * 1000,
  pauseBeforeMs,
  text,
});

describe("paragraphs of a transcript", () => {
  test("pieces with short pauses between them continue one paragraph", () => {
    expect(
      paragraphsOf([
        piece(0, 0, "Memo to file in Novák versus Stavby Praha."),
        piece(1, 20, " I spoke with opposing counsel. "),
      ]),
    ).toEqual([
      {
        startMs: 0,
        text: "Memo to file in Novák versus Stavby Praha. I spoke with opposing counsel.",
      },
    ]);
  });

  test("a long pause, a piece without speech or a long paragraph starts a new one", () => {
    const paragraphs = paragraphsOf([
      piece(0, 0, "First."),
      piece(1, 20, "After a long pause.", 2000),
      piece(2, 40, ""),
      piece(3, 60, "After silence."),
      piece(4, 80, "Still going."),
      piece(5, 100, "Still going."),
      piece(6, 120, "Still going."),
      piece(7, 150, "Past ninety seconds."),
    ]);
    expect(paragraphs.map(({ startMs }) => startMs)).toEqual([
      0, 20_000, 60_000, 150_000,
    ]);
    expect(paragraphs[2]?.text).toBe(
      "After silence. Still going. Still going. Still going.",
    );
  });

  test("pieces are laid out in the order spoken whatever order they came in", () => {
    expect(
      paragraphsOf([piece(1, 20, "second"), piece(0, 0, "first")]),
    ).toEqual([{ startMs: 0, text: "first second" }]);
    expect(paragraphsOf([])).toEqual([]);
    expect(paragraphsOf([piece(0, 0, "  ")])).toEqual([]);
  });

  test("the text copies with or without timestamps", () => {
    const paragraphs = [
      { startMs: 0, text: "One." },
      { startMs: 102_000, text: "Two." },
      { startMs: 3_725_000, text: "Three." },
    ];
    expect(transcriptText(paragraphs, { timestamps: true })).toBe(
      "[0:00] One.\n\n[1:42] Two.\n\n[1:02:05] Three.",
    );
    expect(transcriptText(paragraphs, { timestamps: false })).toBe(
      "One.\n\nTwo.\n\nThree.",
    );
  });
});

describe("times and progress", () => {
  test("timestamps read as minutes and seconds, with hours from an hour on", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(59_999)).toBe("0:59");
    expect(formatTimestamp(195_000)).toBe("3:15");
    expect(formatTimestamp(4 * 3_600_000)).toBe("4:00:00");
    expect(formatTimestamp(-5)).toBe("0:00");
  });

  test("a started minute counts and progress stays within the recording", () => {
    expect(wholeMinutes(0)).toBe(0);
    expect(wholeMinutes(1)).toBe(1);
    expect(wholeMinutes(42 * 60_000)).toBe(42);
    expect(progressShare(30, 60)).toBe(0.5);
    expect(progressShare(90, 60)).toBe(1);
    expect(progressShare(10, null)).toBeNull();
    expect(progressShare(10, 0)).toBeNull();
  });

  test("a recording's title is its file name without the extension", () => {
    expect(recordingTitle("Memo to file 2026-11-14.dss")).toBe(
      "Memo to file 2026-11-14",
    );
    expect(recordingTitle("hearing.recording.m4a")).toBe("hearing.recording");
    expect(recordingTitle(".wav")).toBe(".wav");
    expect(recordingTitle("voice memo")).toBe("voice memo");
  });
});

describe("what native code sends", () => {
  test("file choices, snapshots, pieces and outcomes are checked before use", () => {
    expect(
      isFileChoice({
        status: "ready",
        selection: 1,
        name: "a.m4a",
        format: "M4A",
        durationMs: null,
      }),
    ).toBe(true);
    // A start names the choice back; one without it cannot be started.
    expect(
      isFileChoice({
        status: "ready",
        name: "a.m4a",
        format: "M4A",
        durationMs: null,
      }),
    ).toBe(false);
    expect(
      isRecordingModel({
        id: "elevenlabs-direct/scribe-v3",
        displayName: "Scribe v3",
        provider: null,
        retainsData: true,
      }),
    ).toBe(true);
    expect(isRecordingModel({ id: "m", displayName: "M" })).toBe(false);
    expect(
      isFileChoice({ status: "refused", name: "a.ds2", reason: "dictaphone" }),
    ).toBe(true);
    expect(
      isFileChoice({ status: "refused", name: "a.ds2", reason: "other" }),
    ).toBe(false);
    expect(
      isTranscribeSnapshot({
        available: true,
        localReady: false,
        cloudAvailable: true,
        destination: "cloud",
        file: null,
        running: null,
      }),
    ).toBe(true);
    expect(isTranscribeSnapshot({ available: true })).toBe(false);
    expect(isPieceText(piece(0, 0, "text"))).toBe(true);
    expect(isPieceText({ ...piece(0, 0, "text"), text: 1 })).toBe(false);
    expect(isFinished({ outcome: "done", job: 1, durationMs: 5 })).toBe(true);
    expect(isFinished({ outcome: "failed", job: 1, failure: "cloud" })).toBe(
      true,
    );
    expect(isFinished({ outcome: "failed", job: 1, failure: "x" })).toBe(false);
    expect(isFinished({ outcome: "stopped" })).toBe(false);
  });
});
