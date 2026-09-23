import { describe, expect, test } from "bun:test";

import {
  nextReaderTextScale,
  parseReaderTextScale,
  READER_TEXT_SCALE_DEFAULT,
  READER_TEXT_SCALES,
  readerTextScaleBounds,
} from "@/components/legal-reader/reader-text-scale.logic";

const smallest = READER_TEXT_SCALES[0];
const largest = READER_TEXT_SCALES.at(-1) ?? READER_TEXT_SCALE_DEFAULT;

describe("reader text scale", () => {
  test("the size it opens at is one of the sizes it offers", () => {
    expect(READER_TEXT_SCALES).toContain(READER_TEXT_SCALE_DEFAULT);
  });

  test("the ladder rises", () => {
    const rising = [...READER_TEXT_SCALES].toSorted(
      (left, right) => left - right,
    );
    expect([...READER_TEXT_SCALES]).toEqual(rising);
  });

  test("a step lands on the next rung", () => {
    expect(nextReaderTextScale(READER_TEXT_SCALE_DEFAULT, "in")).toBe(1.1);
    expect(nextReaderTextScale(READER_TEXT_SCALE_DEFAULT, "out")).toBe(0.9);
  });

  test("stepping up walks the ladder rung by rung", () => {
    const walked: number[] = [smallest];
    while (walked.length < READER_TEXT_SCALES.length) {
      walked.push(nextReaderTextScale(walked.at(-1) ?? smallest, "in"));
    }
    expect(walked).toEqual([...READER_TEXT_SCALES]);
  });

  test("the ends hold", () => {
    expect(nextReaderTextScale(smallest, "out")).toBe(smallest);
    expect(nextReaderTextScale(largest, "in")).toBe(largest);
  });

  test("a size no longer offered steps from the nearest one that is", () => {
    expect(nextReaderTextScale(1.14, "in")).toBe(1.2);
    expect(nextReaderTextScale(1.14, "out")).toBe(1);
  });

  test("a button with nothing left to do is at a bound", () => {
    expect(readerTextScaleBounds(READER_TEXT_SCALE_DEFAULT)).toEqual({
      atMax: false,
      atMin: false,
    });
    expect(readerTextScaleBounds(smallest)).toEqual({
      atMax: false,
      atMin: true,
    });
    expect(readerTextScaleBounds(largest)).toEqual({
      atMax: true,
      atMin: false,
    });
  });

  test("only a stored rung is read back", () => {
    for (const rung of READER_TEXT_SCALES) {
      expect(parseReaderTextScale(JSON.stringify(rung))).toBe(rung);
    }
  });

  test("anything else is no choice at all", () => {
    expect(parseReaderTextScale(null)).toBeNull();
    expect(parseReaderTextScale("")).toBeNull();
    expect(parseReaderTextScale("1.15")).toBeNull();
    expect(parseReaderTextScale('"1"')).toBeNull();
    expect(parseReaderTextScale("large")).toBeNull();
    expect(parseReaderTextScale("{}")).toBeNull();
  });
});
