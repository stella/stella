import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { locateQuote } from "@/api/lib/lists/verification/quote-locate";

const words = fc.array(
  fc.constantFrom("částka", "עברית", "العربية", "😀", "e\u0301"),
  {
    minLength: 1,
    maxLength: 12,
  },
);

describe("quote offsets", () => {
  test("exact quote offsets round-trip UTF-16 text", () => {
    assertProperty(
      "exact quote offsets round-trip UTF-16 text",
      fc.property(words, (parts) => {
        const quote = parts.join(" ");
        const prefix = "📄: ";
        const text = `${prefix}${quote} | ${quote}`;
        const first = locateQuote(text, quote);
        expect(first).toEqual({
          start: prefix.length,
          end: prefix.length + quote.length,
        });
        const secondStart = prefix.length + quote.length + 3;
        const second = locateQuote(text, quote, prefix.length + quote.length);
        expect(second).toEqual({
          start: secondStart,
          end: secondStart + quote.length,
        });
        expect(text.slice(second?.start, second?.end)).toBe(quote);
      }),
    );
  });

  test("equivalent quotes round-trip original whitespace and punctuation", () => {
    assertProperty(
      "equivalent quotes round-trip original whitespace and punctuation",
      fc.property(
        words,
        fc.constantFrom("\t", "\r\n", "\u00a0", "  "),
        (parts, space) => {
          const original = `“${parts.join(space)}”`;
          const quote = `"${parts.join(" ")}"`;
          expect(original).not.toBe(quote);
          const prefix = "📄: ";
          const text = `${prefix}${original} | ${original}`;
          const secondStart = prefix.length + original.length + 3;
          const span = locateQuote(
            text,
            quote,
            prefix.length + original.length,
          );
          expect(span).toEqual({
            start: secondStart,
            end: secondStart + original.length,
          });
          expect(text.slice(span?.start, span?.end)).toBe(original);
        },
      ),
    );
  });

  test("prefers an equivalent occurrence after the cursor to an earlier exact one", () => {
    const text = "paid on time; paid\ton time again";
    expect(text.indexOf("paid on time", 12)).toBe(-1);
    expect(locateQuote(text, "paid on time", 12)).toEqual({
      start: 14,
      end: 26,
    });
  });

  test("mixed quote spellings advance in original reading order", () => {
    assertProperty(
      "mixed quote spellings advance in original reading order",
      fc.property(
        words,
        fc.constantFrom("\t", "\r\n", "\u00a0", "  "),
        (parts, space) => {
          const quote = `"${parts.join(" ")}"`;
          const equivalent = `“${parts.join(space)}”`;
          const text = `${equivalent} | ${quote} | ${equivalent}`;
          const first = { start: 0, end: equivalent.length };
          const second = {
            start: first.end + 3,
            end: first.end + 3 + quote.length,
          };
          const third = { start: second.end + 3, end: text.length };
          expect(locateQuote(text, quote)).toEqual(first);
          expect(locateQuote(text, quote, first.end)).toEqual(second);
          expect(locateQuote(text, quote, second.end)).toEqual(third);
          expect(locateQuote(text, quote, third.end)).toEqual(first);
        },
      ),
    );
  });

  test("falls back before the cursor only when no later occurrence exists", () => {
    expect(locateQuote("paid on time", "paid on time", 12)).toEqual({
      start: 0,
      end: 12,
    });
    expect(locateQuote("paid\ton time", "paid on time", 12)).toEqual({
      start: 0,
      end: 12,
    });
    expect(locateQuote("paid on time", " \t\u00a0")).toBeNull();
    expect(locateQuote("paid on time", "not paid on time")).toBeNull();
  });
});
