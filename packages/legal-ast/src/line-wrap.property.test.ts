/**
 * Properties of the hard-wrap display plan over generated documents whose
 * ground truth is known: paragraphs of Czech legal prose wrapped greedily at
 * a random column, between numbered points, headings, blank lines, a date
 * line and a signature block.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Block } from "./document-ast.js";
import {
  LINE_CONTINUATION_SEPARATOR,
  LINE_JOIN,
  LINE_WRAP_TYPE,
  planBlockLineWrap,
  planLineWrap,
} from "./line-wrap.js";
import type { LineJoin } from "./line-wrap.js";

const LOWER_WORDS = [
  "soud",
  "stěžovatel",
  "rozhodnutí",
  "ústavní",
  "stížnost",
  "podle",
  "návrh",
  "řízení",
  "právo",
  "spravedlivý",
  "proces",
  "základní",
  "neboť",
  "obecné",
  "soudy",
  "porušily",
  "přezkoumal",
  "napadené",
  "odůvodnění",
  "protiústavnosti",
  "a",
  "v",
  "s",
  "o",
  "že",
  "který",
  "nepřihlédl",
  "k",
  "důkazům",
  "účastníků",
  "věci",
  "samé",
] as const;

const PROPER_WORDS = [
  "Ústavní",
  "Listiny",
  "Krajského",
  "Nejvyšší",
  "Brně",
  "Evropské",
  "Úmluvy",
] as const;

/** Real compounds whose hyphen a wrapper may break at. */
const COMPOUNDS = ["sociálně-právní", "česko-slovenský", "Brně-venkově"];

/** Mid-sentence citation runs: an abbreviation is always followed by its number. */
const CITATIONS = [
  ["§", "82", "odst.", "1"],
  ["zákona", "č.", "182/1993", "Sb.,"],
  ["čl.", "36", "odst.", "1"],
  ["JUDr.", "Radoslava", "Hrona"],
  ["(viz", "nález", "ze", "dne", "4.", "listopadu", "1998)"],
  ["„Ústavní", "soud", "rozhodl“"],
] as const;

const capitalize = (word: string): string =>
  word.charAt(0).toLocaleUpperCase("cs") + word.slice(1);

/** One sentence as tokens: capitalized first word, final period. */
const sentenceArb = fc
  .array(
    fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom(...LOWER_WORDS) },
      { weight: 1, arbitrary: fc.constantFrom(...PROPER_WORDS) },
      { weight: 1, arbitrary: fc.constantFrom(...COMPOUNDS) },
      {
        weight: 1,
        arbitrary: fc.constantFrom(...CITATIONS).map((run) => run.join(" ")),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(...LOWER_WORDS).map((w) => `${w},`),
      },
    ),
    { minLength: 6, maxLength: 24 },
  )
  .map((parts) => {
    const tokens = parts.join(" ").split(" ");
    const first = capitalize(tokens[0] ?? "Soud");
    const body = [first, ...tokens.slice(1)];
    // A sentence ends on a plain word: a final "1." wrapped to a line start
    // reads as a numbered point, which no reader can tell apart.
    return [...body, "samé."];
  });

/**
 * A wrapped line and what ended it, so the oracle knows each newline's
 * truth without consulting the planner.
 */
type Break = "real" | "sentence" | LineJoin;

type Generated = { lines: string[]; truth: Break[] };

type WrapOptions = { width: number; hyphenate: boolean };

/**
 * Greedy wrap at `width`. A compound may break after its hyphen; a long word
 * may be split with an added hyphen when `hyphenate` is set.
 */
const wrapParagraph = (
  sentences: readonly string[][],
  { width, hyphenate }: WrapOptions,
): Generated => {
  const lines: string[] = [];
  const truth: Break[] = [];
  let line = "";
  const push = (ending: Break) => {
    lines.push(line);
    truth.push(ending);
    line = "";
  };
  for (const sentence of sentences) {
    for (const [index, token] of sentence.entries()) {
      const candidate = line === "" ? token : `${line} ${token}`;
      if (candidate.length <= width) {
        line = candidate;
      } else {
        const hyphenAt = token.indexOf("-");
        const compoundHead = token.slice(0, hyphenAt + 1);
        if (hyphenAt > 0 && `${line} ${compoundHead}`.length <= width) {
          line = `${line} ${compoundHead}`;
          push(LINE_JOIN.HYPHEN);
          line = token.slice(hyphenAt + 1);
        } else if (
          hyphenate &&
          token.length >= 8 &&
          /^\p{L}+$/u.test(token.slice(0, 4)) &&
          `${line} ${token.slice(0, 3)}-`.length <= width
        ) {
          line = `${line} ${token.slice(0, 3)}-`;
          push(LINE_JOIN.HYPHEN);
          line = token.slice(3);
        } else {
          // Wrapping before a sentence's first word breaks at its boundary.
          push(index === 0 ? "sentence" : LINE_JOIN.SPACE);
          line = token;
        }
      }
    }
  }
  lines.push(line);
  truth.push("real");
  return { lines, truth };
};

const STRUCTURAL_LINES = [
  "N Á L E Z",
  "ODŮVODNĚNÍ",
  "Odůvodnění:",
  "takto:",
  "II.",
  "",
  "V Brně dne 4. listopadu 1998",
] as const;

type DocumentPart =
  | { type: "paragraph"; sentences: string[][]; number: number | null }
  | { type: "structural"; line: string };

const paragraphArb = (minSentences: number): fc.Arbitrary<DocumentPart> =>
  fc.record({
    type: fc.constant("paragraph" as const),
    sentences: fc.array(sentenceArb, {
      minLength: minSentences,
      maxLength: minSentences + 3,
    }),
    number: fc.option(fc.integer({ min: 1, max: 40 }), { nil: null }),
  });

const partArb = (minSentences: number): fc.Arbitrary<DocumentPart> =>
  fc.oneof(
    { weight: 4, arbitrary: paragraphArb(minSentences) },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant("structural" as const),
        line: fc.constantFrom(...STRUCTURAL_LINES),
      }),
    },
  );

const SIGNATURE = ["JUDr. Radoslav Hron", "předseda senátu"];

const assemble = (parts: readonly DocumentPart[], options: WrapOptions) => {
  const lines: string[] = [];
  const truth: Break[] = [];
  for (const part of parts) {
    if (part.type === "structural") {
      lines.push(part.line);
      truth.push("real");
      continue;
    }
    const sentences =
      part.number === null
        ? part.sentences
        : [
            [`${String(part.number)}.`, ...(part.sentences[0] ?? [])],
            ...part.sentences.slice(1),
          ];
    const wrapped = wrapParagraph(sentences, options);
    lines.push(...wrapped.lines);
    truth.push(...wrapped.truth);
  }
  for (const line of SIGNATURE) {
    lines.push(line);
    truth.push("real");
  }
  // The last line ends the document; there is no boundary after it.
  truth.pop();
  return { lines, truth };
};

const documentArb = (minSentences: number) =>
  fc
    .record({
      parts: fc.array(partArb(minSentences), { minLength: 3, maxLength: 12 }),
      width: fc.integer({ min: 50, max: 80 }),
      hyphenate: fc.boolean(),
    })
    .map(({ parts, width, hyphenate }) => ({
      parts,
      width,
      ...assemble(parts, { width, hyphenate }),
    }));

/** Any mix, down to one-sentence paragraphs that barely wrap at all. */
const anyDocumentArb = documentArb(1);

/** Mostly multi-line paragraphs: what a hard-wrapped export looks like. */
const wrappedDocumentArb = documentArb(3).filter(
  ({ parts }) => parts.filter((part) => part.type === "paragraph").length >= 3,
);

/** The lines as a reader draws them under `joins`. */
const drawn = (lines: readonly string[], joins: readonly LineJoin[]) => {
  let text = lines[0] ?? "";
  const starts = [0];
  for (const [index, line] of lines.slice(1).entries()) {
    const join = joins[index] ?? LINE_JOIN.BREAK;
    text += join === LINE_JOIN.BREAK ? "\n" : LINE_CONTINUATION_SEPARATOR[join];
    starts.push(text.length);
    text += line;
  }
  return { text, starts };
};

/** What the reader should draw: wraps joined, sentence and real breaks kept. */
const expectedJoins = (truth: readonly Break[]): LineJoin[] =>
  truth.map((ending) =>
    ending === "real" || ending === "sentence" ? LINE_JOIN.BREAK : ending,
  );

const paragraphBlocks = (lines: readonly string[]): Block[] =>
  lines.map((line, index) => ({
    id: `b${String(index)}`,
    anchorId: `p-${String(index)}`,
    type: "paragraph",
    inlines: [{ type: "text", text: line }],
    plainText: line,
  }));

describe("hard-wrap display plan", () => {
  test("joins exactly the wrapper's newlines inside a sentence", () => {
    assertProperty(
      "joins exactly the wrapper's newlines inside a sentence",
      fc.property(wrappedDocumentArb, ({ lines, truth, width }) => {
        const plan = planLineWrap(lines);
        expect(plan.classification.type).toBe(
          LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED,
        );
        if (plan.classification.type === LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED) {
          expect(plan.classification.width).toBeLessThanOrEqual(width);
        }
        expect(plan.joins).toEqual(expectedJoins(truth));
        // The drawn text is the source with only those newlines replaced.
        const source = lines.join("\n");
        const { text } = drawn(lines, plan.joins);
        expect(text.replaceAll(/[ \n]/gu, "")).toBe(
          source.replaceAll(/[ \n]/gu, ""),
        );
        expect(text.split("\n").length).toBe(
          plan.joins.filter((join) => join === LINE_JOIN.BREAK).length + 1,
        );
      }),
      { numRuns: 300 },
    );
  });

  test("every anchor keeps pointing at the same character", () => {
    assertProperty(
      "every anchor keeps pointing at the same character",
      fc.property(
        anyDocumentArb,
        fc.nat(),
        fc.nat(),
        ({ lines }, lineSeed, offsetSeed) => {
          const blocks = paragraphBlocks(lines);
          const before = structuredClone(blocks);
          const plan = planBlockLineWrap(blocks);
          expect(blocks).toEqual(before);
          const joins = blocks
            .slice(1)
            .map(
              (block) => plan.continuations.get(block.id) ?? LINE_JOIN.BREAK,
            );
          const { text, starts } = drawn(lines, joins);
          const lineIndex = lineSeed % lines.length;
          const line = lines[lineIndex] ?? "";
          if (line === "") {
            return;
          }
          const offset = offsetSeed % line.length;
          const start = starts[lineIndex] ?? -1;
          expect(text[start + offset]).toBe(line[offset]);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("real paragraph breaks survive", () => {
    assertProperty(
      "real paragraph breaks survive",
      fc.property(anyDocumentArb, ({ lines, truth }) => {
        const { joins } = planLineWrap(lines);
        for (const [index, ending] of truth.entries()) {
          // A sentence boundary may be a paragraph's end; neither is joined.
          const join = joins.at(index);
          if (ending === "real" || ending === "sentence") {
            expect(join).toBe(LINE_JOIN.BREAK);
          } else {
            // A wrap may stay a break (too little evidence), never the
            // wrong kind of join.
            expect(join === LINE_JOIN.BREAK || join === ending).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("an unwrapped document is drawn unchanged", () => {
    assertProperty(
      "an unwrapped document is drawn unchanged",
      fc.property(
        fc.array(partArb(1), { minLength: 1, maxLength: 20 }),
        (parts) => {
          // Each paragraph on one line, as a normal publisher stores it.
          const lines = parts.map((part) =>
            part.type === "structural"
              ? part.line
              : part.sentences.map((sentence) => sentence.join(" ")).join(" "),
          );
          const plan = planLineWrap(lines);
          expect(plan.joins.every((join) => join === LINE_JOIN.BREAK)).toBe(
            true,
          );
          expect(drawn(lines, plan.joins).text).toBe(lines.join("\n"));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("drawing a drawn document changes nothing", () => {
    assertProperty(
      "drawing a drawn document changes nothing",
      fc.property(anyDocumentArb, ({ lines }) => {
        const once = drawn(lines, planLineWrap(lines).joins).text.split("\n");
        const twice = drawn(once, planLineWrap(once).joins).text;
        expect(twice).toBe(once.join("\n"));
      }),
      { numRuns: 300 },
    );
  });
});
