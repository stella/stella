import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { LIMITS } from "@/api/lib/limits";

import { locateDecisionBlocks } from "./case-law-decision-outline";
import {
  normalizeQuote,
  quoteInputWithinBudget,
  rawQuoteSegments,
  verifyQuote,
} from "./verify-quote.logic";

const run = (text: string, quote: string) =>
  verifyQuote({ text, quote, located: [], url: null });
const paragraph = (text: string, number: number): Block => ({
  type: "paragraph",
  id: `p${number}`,
  anchorId: `p${number}`,
  number,
  plainText: text,
  inlines: [{ type: "text", text }],
});

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

describe("quotation verification", () => {
  test("normalizes typography without changing letters, case or punctuation", () => {
    expect(
      normalizeQuote("„č.\u00a0j. 15 – správ-\nní\u00ad řízení“").text,
    ).toBe('"č. j. 15 - správní řízení"');
    expect(
      run("„č.j. 15 – správ-\nní řízení“", '"č. j. 15 - správní řízení"')
        .status,
    ).toBe("exact");
    expect(run("správ-\nní", "správ-").status).toBe("exact");
    for (const quote of ["rizeni", "Řízení", "řízené"]) {
      expect(run("řízení", quote).verified).toBe(false);
    }
  });
  test("a quote is whole words: a fragment of a longer word is not found", () => {
    expect(run("Žalovaný nesplnil povinnost.", "ne").verified).toBe(false);
    expect(run("Žalovaný nesplnil povinnost.", "splnil").verified).toBe(false);
    expect(run("Žalovaný ne splnil povinnost.", "ne").verified).toBe(true);
    expect(run("Soud ne-rozhodl.", "ne").verified).toBe(true);
  });
  test("names how many occurrences there are and returns a bounded number", () => {
    const result = run("a ".repeat(LIMITS.caseLawQuoteMaxOccurrences + 5), "a");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") {
      return;
    }
    const segment = result.segments.at(0);
    expect(segment?.occurrenceCount).toBe(
      LIMITS.caseLawQuoteMaxOccurrences + 5,
    );
    expect(segment?.occurrences).toHaveLength(
      LIMITS.caseLawQuoteMaxOccurrences,
    );
  });
  test("a leading or trailing ellipsis marks a cut, not a segment", () => {
    expect(run("Soud rozhodl.", "… Soud rozhodl").verified).toBe(true);
    expect(run("Soud rozhodl.", "Soud rozhodl …").verified).toBe(true);
  });
  test("returns every overlapping occurrence and original positions", () => {
    const result = run("a a a", "a a");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") {
      return;
    }
    expect(
      result.segments.at(0)?.occurrences.map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 3],
      [2, 5],
    ]);
  });
  test("locates a quote crossing paragraphs with canonical labels and deep links", () => {
    const text = "První odstavec.\n\nDruhý odstavec.";
    const blocks = [
      paragraph("První odstavec.", 10),
      paragraph("Druhý odstavec.", 11),
    ];
    const result = verifyQuote({
      text,
      quote: "odstavec. Druhý",
      located: locateDecisionBlocks(blocks, text),
      url: "https://example.test/decision",
    });
    expect(result.status).toBe("exact");
    if (result.status !== "exact") {
      return;
    }
    expect(result.segments.at(0)?.occurrences.at(0)?.paragraphs).toEqual([
      {
        position: 1,
        label: "10",
        headingPath: [],
        url: "https://example.test/decision#par=10",
      },
      {
        position: 2,
        label: "11",
        headingPath: [],
        url: "https://example.test/decision#par=11",
      },
    ]);
  });
  test.each(["...", "…", "[…]", "(...)"])(
    "matches ordered ellipsis segments with %s",
    (marker) => {
      const result = run("alpha beta alpha gamma beta", `alpha ${marker} beta`);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") {
        return;
      }
      expect(
        result.segments.map(({ occurrences }) =>
          occurrences.map(({ start }) => start),
        ),
      ).toEqual([
        [0, 11],
        [6, 23],
      ]);
      expect(run("beta alpha", `alpha ${marker} beta`).verified).toBe(false);
    },
  );
  test("an altered word is unverified and shows passage-to-quote differences", () => {
    const result = run(
      "Soud návrh zamítl pro opožděnost podání.",
      "Soud návrh přijal pro opožděnost podání.",
    );
    expect(result.status).toBe("fuzzy");
    expect(result.verified).toBe(false);
    if (result.status === "exact") {
      return;
    }
    expect(
      result.segments
        .at(0)
        ?.closest?.differences.filter(({ type }) => type !== "equal"),
    ).toEqual([
      { type: "dropped", words: ["zamítl"] },
      { type: "added", words: ["přijal"] },
    ]);
  });
  test("rejects empty ellipses and over-budget comparison segments", () => {
    expect(quoteInputWithinBudget("[…] ...")).toBe(false);
    expect(quoteInputWithinBudget("word ".repeat(129))).toBe(false);
  });
  test("quotation-substrings-preserve-paragraph-position", () => {
    assertProperty(
      "quotation-substrings-preserve-paragraph-position",
      fc.property(
        fc
          .array(
            fc.constantFrom(
              "a",
              "ž",
              "ě",
              "Ú",
              "9",
              ".",
              " ",
              "č.j.",
              "správ-\nní",
              "\u00ad",
              "„",
              "“",
              "–",
              "\u00a0",
            ),
            {
              minLength: 1,
              maxLength: 50,
            },
          )
          .filter((chars) => chars.join("").trim().length > 0),
        fc.nat(),
        fc.nat(),
        (chars, first, second) => {
          const body = chars.join("");
          const prefix = "Záhlaví\n\n";
          const text = `${prefix}${body}\n\nKonec`;
          let start = Math.min(first % body.length, second % body.length);
          let end = Math.max(first % body.length, second % body.length) + 1;
          // A quote is whole words, so widen the slice to its word edges.
          while (
            start > 0 &&
            WORD_CHARACTER.test(body.charAt(start - 1)) &&
            WORD_CHARACTER.test(body.charAt(start))
          ) {
            start -= 1;
          }
          while (
            end < body.length &&
            WORD_CHARACTER.test(body.charAt(end - 1)) &&
            WORD_CHARACTER.test(body.charAt(end))
          ) {
            end += 1;
          }
          const quote = body.slice(start, end);
          fc.pre(quoteInputWithinBudget(quote));
          const result = verifyQuote({
            text,
            quote,
            located: locateDecisionBlocks(
              [
                paragraph("Záhlaví", 1),
                paragraph(body, 2),
                paragraph("Konec", 3),
              ],
              text,
            ),
            url: null,
          });
          expect(result.status).toBe("exact");
          if (result.status !== "exact") {
            return;
          }
          expect(result.verified).toBe(true);
          expect(
            result.segments
              .at(0)
              ?.occurrences.some(
                ({ start: foundStart, paragraphs }) =>
                  foundStart ===
                    prefix.length +
                      start +
                      quote.indexOf(rawQuoteSegments(quote).at(0) ?? "") &&
                  paragraphs.at(0)?.position === 2,
              ),
          ).toBe(true);
        },
      ),
    );
  });
  test("quotation-word-changes-never-verify", () => {
    assertProperty(
      "quotation-word-changes-never-verify",
      fc.property(
        fc.array(
          fc.constantFrom("soud", "návrh", "odmítl", "žalobu", "řízení"),
          { minLength: 1, maxLength: 30 },
        ),
        fc.nat(),
        (words, position) => {
          const changed = words
            .map((word, index) =>
              index === position % words.length ? "NEEXISTUJÍCÍ" : word,
            )
            .join(" ");
          expect(run(words.join(" "), changed).verified).toBe(false);
        },
      ),
    );
  });
});
