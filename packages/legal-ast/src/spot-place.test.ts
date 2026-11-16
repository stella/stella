import { describe, expect, test } from "bun:test";

import { placeSpotText } from "./spot-place";

const digest = "a".repeat(64);
const quote = "deliver the goods";
const text = `Article 4\nThe seller shall ${quote}\nwithin thirty days.`;
const start = text.indexOf(quote);

const place = (overrides: Partial<Parameters<typeof placeSpotText>[0]> = {}) =>
  placeSpotText({
    start,
    end: start + quote.length,
    quote,
    storedDigest: digest,
    text,
    textDigest: digest,
    sameVersion: true,
    ...overrides,
  });

describe("placeSpotText", () => {
  test("uses offsets only when both digest and sliced words match", () => {
    expect(place()).toEqual({
      type: "placed",
      start,
      end: start + quote.length,
    });
    expect(place({ start: 0, end: 7 })).toEqual({
      type: "placed",
      start,
      end: start + quote.length,
    });
  });

  test("finds moved words nearest their old place on the same version", () => {
    const moved = `Preamble\n${text}`;
    const movedStart = moved.indexOf(quote);
    expect(place({ text: moved, textDigest: "b".repeat(64) })).toEqual({
      type: "placed",
      start: movedStart,
      end: movedStart + quote.length,
    });
  });

  test("chooses repeated wording nearest the old start", () => {
    const repeated = `${quote}\nxxxxxxxxxx\n${quote}\nxxxxxxxxxx\n${quote}`;
    const nearest = repeated.lastIndexOf(quote);
    expect(
      place({
        start: nearest - 1,
        end: nearest - 1 + quote.length,
        text: repeated,
        textDigest: "b".repeat(64),
      }),
    ).toEqual({ type: "placed", start: nearest, end: nearest + quote.length });
  });

  test("matches quote folding and ignores whitespace", () => {
    const foldedText = "He said, “deliver\u00a0  the\ngoods”—today.";
    const foldedQuote = "“deliver the goods” — today";
    const foldedStart = foldedText.indexOf("“");
    expect(
      place({
        start: foldedStart,
        end: foldedStart + foldedQuote.length,
        quote: foldedQuote,
        text: foldedText,
        textDigest: "b".repeat(64),
      }),
    ).toEqual({
      type: "placed",
      start: foldedStart,
      end: foldedText.indexOf("."),
    });
  });

  test("detaches changed text from another version", () => {
    expect(place({ text: `Preamble\n${text}`, sameVersion: false })).toEqual({
      type: "detached",
      reason: "other-version",
    });
  });

  test("detaches when words disappeared from the same version", () => {
    expect(place({ text: "The buyer pays.", textDigest: digest })).toEqual({
      type: "detached",
      reason: "text-changed",
    });
  });
});
