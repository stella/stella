import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  exportJson,
  exportMarkdown,
  exportSrt,
  exportTxt,
  exportVtt,
} from "./exporters";
import { parseTranscript } from "./transcript";
import type { TimedText, Transcript } from "./transcript";

const fixture = {
  language: "cs",
  durationMs: 5000,
  segments: [
    { startMs: 0, endMs: 1500, text: "Paní Žárková předložila listinu." },
    { startMs: 2500, endMs: 5000, text: "Pán Ľubor Čerešňa súhlasí." },
  ],
} satisfies Transcript;

const parseTime = (input: string, separator: "," | ".") => {
  const match = /^(\d{2,}):(\d{2}):(\d{2})([,.])(\d{3})$/u.exec(input);
  expect(match).not.toBeNull();
  expect(match?.at(4)).toBe(separator);
  const hours = Number(match?.at(1));
  const minutes = Number(match?.at(2));
  const seconds = Number(match?.at(3));
  expect(minutes).toBeLessThan(60);
  expect(seconds).toBeLessThan(60);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(match?.at(5));
};

const parseSubtitles = (output: string, format: "srt" | "vtt") => {
  let body = output;
  if (format === "vtt") {
    expect(output.startsWith("WEBVTT\n\n")).toBe(true);
    body = output.slice("WEBVTT\n\n".length);
  }
  if (body.length === 0) {
    return [];
  }
  const cues: TimedText[] = [];
  for (const [index, block] of body.trimEnd().split("\n\n").entries()) {
    const lines = block.split("\n");
    if (format === "srt") {
      expect(lines.shift()).toBe(String(index + 1));
    }
    const timing = lines.shift()?.split(" --> ");
    expect(timing?.length).toBe(2);
    const startMs = parseTime(
      timing?.at(0) ?? "",
      format === "srt" ? "," : ".",
    );
    const endMs = parseTime(timing?.at(1) ?? "", format === "srt" ? "," : ".");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.length > 0)).toBe(true);
    expect(startMs).toBeLessThan(endMs);
    cues.push({
      startMs,
      endMs,
      text: lines
        .join("\n")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    });
  }
  return cues;
};

describe("text export fixtures", () => {
  test("emits the plain paragraphs", () => {
    expect(exportTxt(fixture).unwrap()).toBe(
      "Paní Žárková předložila listinu.\n\nPán Ľubor Čerešňa súhlasí.",
    );
  });
  test("emits Markdown with optional timestamps and literal punctuation", () => {
    expect(exportMarkdown(fixture).unwrap()).toBe(
      "Paní Žárková předložila listinu\\.\n\nPán Ľubor Čerešňa súhlasí\\.",
    );
    expect(exportMarkdown(fixture, { timestamps: true }).unwrap()).toBe(
      "[00:00:00.000] Paní Žárková předložila listinu\\.\n\n[00:00:02.500] Pán Ľubor Čerešňa súhlasí\\.",
    );
  });
  test("emits numbered SRT cues", () => {
    expect(exportSrt(fixture).unwrap()).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nPaní Žárková předložila listinu.\n\n2\n00:00:02,500 --> 00:00:05,000\nPán Ľubor Čerešňa súhlasí.\n",
    );
  });
  test("emits a VTT header and dot-separated milliseconds", () => {
    expect(exportVtt(fixture).unwrap()).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nPaní Žárková předložila listinu.\n\n00:00:02.500 --> 00:00:05.000\nPán Ľubor Čerešňa súhlasí.\n",
    );
  });
  test("emits canonical versioned JSON", () => {
    expect(exportJson(fixture).unwrap()).toBe(`{
  "version": 1,
  "transcript": {
    "language": "cs",
    "durationMs": 5000,
    "segments": [
      {
        "startMs": 0,
        "endMs": 1500,
        "text": "Paní Žárková předložila listinu."
      },
      {
        "startMs": 2500,
        "endMs": 5000,
        "text": "Pán Ľubor Čerešňa súhlasí."
      }
    ]
  }
}`);
    expect(parseTranscript(exportJson(fixture).unwrap()).unwrap()).toEqual(
      fixture,
    );
  });
});

test("empty transcripts and blank segments produce no subtitle cues", () => {
  const empty = { durationMs: 0, segments: [] } satisfies Transcript;
  expect(exportTxt(empty).unwrap()).toBe("");
  expect(exportMarkdown(empty).unwrap()).toBe("");
  expect(exportSrt(empty).unwrap()).toBe("");
  expect(exportVtt(empty).unwrap()).toBe("WEBVTT\n\n");
  expect(
    exportSrt({
      durationMs: 0,
      segments: [{ startMs: 0, endMs: 0, text: "\n \t" }],
    }).unwrap(),
  ).toBe("");
});

test("subtitle options and impossible cue durations return typed failures", () => {
  for (const options of [
    { maxLineLength: 0 },
    { maxLineLength: 1.5 },
    { minCueDurationMs: Number.NaN },
    { maxCueDurationMs: Number.POSITIVE_INFINITY },
    { minCueDurationMs: 2000, maxCueDurationMs: 1000 },
    { minCueDurationMs: 3000 },
  ]) {
    expect(exportSrt(fixture, options).isErr()).toBe(true);
    expect(exportVtt(fixture, options).isErr()).toBe(true);
  }
  const shortText = {
    durationMs: 10_000,
    segments: [{ startMs: 0, endMs: 10_000, text: "a" }],
  } satisfies Transcript;
  expect(exportSrt(shortText, { maxCueDurationMs: 1000 }).isErr()).toBe(true);
  const zero = {
    durationMs: 1,
    segments: [{ startMs: 1, endMs: 1, text: "slovo" }],
  } satisfies Transcript;
  expect(exportSrt(zero).isErr()).toBe(true);
});

test("subtitle text cannot introduce cue blocks or markup", () => {
  const transcript = {
    durationMs: 1000,
    segments: [
      { startMs: 0, endMs: 1000, text: "<b>Žárková</b>\n\n --> &lt;" },
    ],
  } satisfies Transcript;
  for (const [format, output] of [
    ["srt", exportSrt(transcript).unwrap()],
    ["vtt", exportVtt(transcript).unwrap()],
  ] as const) {
    const parsed = parseSubtitles(output, format);
    expect(parsed).toHaveLength(1);
    expect(parsed.at(0)?.text).toBe("<b>Žárková</b> --> &lt;");
    expect(output).not.toContain("<b>");
  }
});

test("SRT explicitly rejects three-digit hours while VTT retains them", () => {
  const transcript = {
    durationMs: 360_001_000,
    segments: [{ startMs: 360_000_000, endMs: 360_001_000, text: "Listina" }],
  } satisfies Transcript;
  expect(exportSrt(transcript).isErr()).toBe(true);
  expect(exportVtt(transcript).unwrap()).toBe(
    "WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nListina\n",
  );
});

const subtitleArbitrary = fc
  .array(
    fc.record({
      gapMs: fc.integer({ min: 0, max: 5000 }),
      durationMs: fc.integer({ min: 1000, max: 20_000 }),
      words: fc.array(
        fc.constantFrom(
          "Žárková",
          "Ľubor",
          "Čerešňa",
          "listina",
          "předložila",
          "súhlasí",
          "🗂️",
        ),
        { minLength: 25, maxLength: 50 },
      ),
    }),
    { maxLength: 12 },
  )
  .map((entries) => {
    let durationMs = 0;
    const segments = entries.map(
      ({ gapMs, durationMs: segmentDuration, words }) => {
        const startMs = durationMs + gapMs;
        durationMs = startMs + segmentDuration;
        return { startMs, endMs: durationMs, text: words.join(" ") };
      },
    );
    return { durationMs, segments } satisfies Transcript;
  });

test("subtitle exports parse back with bounded cues, wrapping and full text", () => {
  assertProperty(
    "subtitle exports parse back with bounded cues, wrapping and full text",
    fc.property(
      subtitleArbitrary,
      fc.integer({ min: 5, max: 42 }),
      (transcript, maxLineLength) => {
        const options = {
          maxLineLength,
          minCueDurationMs: 500,
          maxCueDurationMs: 3000,
        };
        for (const [format, output] of [
          ["srt", exportSrt(transcript, options).unwrap()],
          ["vtt", exportVtt(transcript, options).unwrap()],
        ] as const) {
          const cues = parseSubtitles(output, format);
          for (const [index, cue] of cues.entries()) {
            expect(cue.endMs - cue.startMs).toBeGreaterThanOrEqual(
              options.minCueDurationMs,
            );
            expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(
              options.maxCueDurationMs,
            );
            expect(cue.endMs).toBeLessThanOrEqual(transcript.durationMs);
            expect(cue.startMs).toBeGreaterThanOrEqual(
              index === 0 ? 0 : (cues.at(index - 1)?.startMs ?? 0),
            );
            for (const line of cue.text.split("\n")) {
              expect(Array.from(line).length).toBeLessThanOrEqual(
                maxLineLength,
              );
            }
          }
          expect(
            cues
              .map(({ text }) => text.replaceAll("\n", "").replaceAll(" ", ""))
              .join(""),
          ).toBe(
            transcript.segments
              .map(({ text }) => text.replaceAll(" ", ""))
              .join(""),
          );
        }
      },
    ),
  );
});

test("overlapping source segments retain stable chronological cue order", () => {
  const transcript = {
    durationMs: 10_000,
    segments: [
      {
        startMs: 0,
        endMs: 10_000,
        text: "První listina má deset slov a čtyři části svého obsahu.",
      },
      { startMs: 1000, endMs: 2000, text: "Druhá listina." },
    ],
  } satisfies Transcript;
  expect(
    parseSubtitles(exportSrt(transcript).unwrap(), "srt").map(
      ({ startMs }) => startMs,
    ),
  ).toEqual([0, 1000, 5000]);
});

test("subtitle cue arithmetic retains exact safe-integer endpoints", () => {
  const transcript = {
    durationMs: Number.MAX_SAFE_INTEGER,
    segments: [
      { startMs: 0, endMs: Number.MAX_SAFE_INTEGER, text: "První druhá třetí" },
    ],
  } satisfies Transcript;
  const cues = parseSubtitles(
    exportVtt(transcript, {
      maxCueDurationMs: Math.floor(Number.MAX_SAFE_INTEGER / 2),
    }).unwrap(),
    "vtt",
  );
  expect(cues).toHaveLength(3);
  expect(cues.at(0)?.startMs).toBe(0);
  expect(cues.at(-1)?.endMs).toBe(Number.MAX_SAFE_INTEGER);
  for (const [index, cue] of cues.entries()) {
    expect(Number.isSafeInteger(cue.startMs)).toBe(true);
    expect(Number.isSafeInteger(cue.endMs)).toBe(true);
    if (index > 0) {
      expect(cues.at(index - 1)?.endMs).toBe(cue.startMs);
    }
    expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(
      Math.floor(Number.MAX_SAFE_INTEGER / 2),
    );
  }
});

test("subtitle partitions keep every feasible cue nonempty around whitespace", () => {
  for (const text of [
    "ab cd",
    "a  b  c  d",
    "  a  b  c  d  ",
    "\ta\t \nb\r\n c\u00a0d ",
  ]) {
    const transcript = {
      durationMs: 28_000,
      segments: [{ startMs: 0, endMs: 28_000, text }],
    } satisfies Transcript;
    for (const [format, output] of [
      ["srt", exportSrt(transcript).unwrap()],
      ["vtt", exportVtt(transcript).unwrap()],
    ] as const) {
      const cues = parseSubtitles(output, format);
      expect(cues.map(({ text: part }) => part)).toEqual(["a", "b", "c", "d"]);
      expect(cues.map(({ startMs, endMs }) => endMs - startMs)).toEqual([
        7000, 7000, 7000, 7000,
      ]);
    }
  }
});

const whitespaceRun = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((characters) => characters.join(""));

test("subtitle partitions preserve all nonwhitespace text for feasible cue counts", () => {
  assertProperty(
    "subtitle partitions preserve all nonwhitespace text for feasible cue counts",
    fc.property(
      fc.array(
        fc.record({
          word: fc.constantFrom("ab", "Žofii", "č", "Ľubor", "🗂️"),
          whitespace: whitespaceRun,
        }),
        { minLength: 1, maxLength: 20 },
      ),
      fc.nat(),
      whitespaceRun,
      (entries, choice, trailingWhitespace) => {
        const text =
          entries.map(({ word, whitespace }) => whitespace + word).join("") +
          trailingWhitespace;
        const content = entries.map(({ word }) => word).join("");
        const count = 1 + (choice % Array.from(content).length);
        const durationMs = count * 7000;
        const transcript = {
          durationMs,
          segments: [{ startMs: 0, endMs: durationMs, text }],
        };
        for (const [format, output] of [
          ["srt", exportSrt(transcript).unwrap()],
          ["vtt", exportVtt(transcript).unwrap()],
        ] as const) {
          const cues = parseSubtitles(output, format);
          expect(cues).toHaveLength(count);
          expect(cues.every(({ text: part }) => part.trim().length > 0)).toBe(
            true,
          );
          expect(
            cues.map(({ text: part }) => part.replaceAll(/\s/gu, "")).join(""),
          ).toBe(content);
        }
      },
    ),
  );
});
