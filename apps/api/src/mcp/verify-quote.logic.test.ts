import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { locateDecisionBlocks } from "./case-law-decision-outline";
import {
  normalizeQuote,
  quoteInputWithinBudget,
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
  test("returns every overlapping occurrence and original positions", () => {
    const result = run("aaaa", "aa");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") {
      return;
    }
    expect(
      result.segments.at(0)?.occurrences.map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
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
          const start = Math.min(first % body.length, second % body.length);
          const end = Math.max(first % body.length, second % body.length) + 1;
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
                    prefix.length + start + quote.indexOf(quote.trim()) &&
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
