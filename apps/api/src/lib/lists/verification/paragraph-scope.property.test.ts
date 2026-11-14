/**
 * What must hold for any numbered statement laid out on PDF pages: a range
 * of its printed paragraph numbers resolves to exactly the text from the
 * start of the first paragraph to where the next paragraph's section begins,
 * in the coordinates of the whole document, and a number the statement does
 * not print is refused, never widened.
 */

import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  resolveParagraphScope,
  scopePassages,
} from "@/api/lib/lists/verification/paragraph-scope";

const WRAP_WIDTH = 72;

const COVER = [
  "Witness Name: Sample Witness",
  "Statement No: 2",
  "Exhibits: SW2/1 - SW2/40",
  "Dated: 3 June 2025",
  "SECOND WITNESS STATEMENT OF SAMPLE WITNESS",
  "I, Sample Witness, will say as follows",
] as const;

const WORDS = [
  "the",
  "care",
  "homes",
  "discharge",
  "guidance",
  "was",
  "agreed",
  "with",
  "local",
  "authorities",
  "and",
  "testing",
  "capacity",
  "hospital",
  "patients",
  "staff",
  "officials",
  "advised",
  "department",
  "funding",
] as const;

const sentence = fc
  .array(fc.constantFrom(...WORDS), { minLength: 10, maxLength: 36 })
  .map((words) => {
    const text = words.join(" ");
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  });

const paragraphBody = fc
  .array(sentence, { minLength: 1, maxLength: 3 })
  .map((sentences) => sentences.join(" "));

/** Greedy wrapping at one column, as a word processor's PDF export sets a
 *  justified page. */
const wrap = (text: string): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > WRAP_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
};

type Line = {
  text: string;
  /** The paragraph whose section the line belongs to; 0 for the cover. */
  section: number;
  /** Whether the line opens its section (its heading, else its number). */
  opensSection: boolean;
};

const statement = fc.record({
  bodies: fc.array(paragraphBody, { minLength: 4, maxLength: 30 }),
  headed: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
  linesPerPage: fc.integer({ min: 18, max: 46 }),
});

type Statement = {
  blocks: VerificationBlock[];
  /** Where each paragraph's section begins and its number starts. */
  sectionStart: Map<number, { blockId: string; offset: number }>;
  numberStart: Map<number, { blockId: string; offset: number }>;
  count: number;
};

const layOut = ({
  bodies,
  headed,
  linesPerPage,
}: {
  bodies: string[];
  headed: boolean[];
  linesPerPage: number;
}): Statement => {
  const lines: Line[] = COVER.map((text) => ({
    text,
    section: 0,
    opensSection: false,
  }));
  for (const [index, body] of bodies.entries()) {
    const number = index + 1;
    const heading = number > 1 && headed[index] === true;
    if (heading) {
      lines.push({
        text: "Discharge policy",
        section: number,
        opensSection: true,
      });
    }
    for (const [lineIndex, text] of wrap(
      `${String(number)}. ${body}`,
    ).entries()) {
      lines.push({
        text,
        section: number,
        opensSection: !heading && lineIndex === 0,
      });
    }
  }
  const blocks: VerificationBlock[] = [];
  const sectionStart = new Map<number, { blockId: string; offset: number }>();
  const numberStart = new Map<number, { blockId: string; offset: number }>();
  for (let from = 0; from < lines.length; from += linesPerPage) {
    const pageLines = lines.slice(from, from + linesPerPage);
    const pageNumber = blocks.length + 1;
    const id = `P${String(pageNumber)}`;
    let offset = 0;
    for (const line of pageLines) {
      if (line.opensSection) {
        sectionStart.set(line.section, { blockId: id, offset });
      }
      if (line.text.startsWith(`${String(line.section)}. `)) {
        numberStart.set(line.section, { blockId: id, offset });
      }
      offset += line.text.length + 1;
    }
    blocks.push({
      id,
      text: pageLines.map((line) => line.text).join("\n"),
      source: { type: "pdf-page", pageNumber },
      structure: { type: "pdf-lines", boxes: null },
    });
  }
  return { blocks, sectionStart, numberStart, count: bodies.length };
};

const withRange = statement.chain((input) =>
  fc
    .tuple(
      fc.integer({ min: 1, max: input.bodies.length }),
      fc.integer({ min: 1, max: input.bodies.length }),
    )
    .map(([a, b]) => ({
      input,
      from: Math.min(a, b),
      to: Math.max(a, b),
    })),
);

test("a printed paragraph range resolves to its own text in whole-document coordinates", () => {
  assertProperty(
    "a printed paragraph range resolves to its own text in whole-document coordinates",
    fc.property(withRange, ({ input, from, to }) => {
      const { blocks, sectionStart, numberStart } = layOut(input);
      const resolution = resolveParagraphScope(blocks, { from, to });
      if (resolution.type !== "resolved") {
        throw new Error(`Expected a resolved range, got ${resolution.type}`);
      }
      const { scope } = resolution;
      expect(scope.numbering).toBe("document");
      const firstStart =
        numberStart.get(from) ?? panic("Every laid-out paragraph has a start");
      expect(scope.start).toEqual(firstStart);
      const last = blocks.at(-1) ?? panic("A statement has a page");
      const documentEnd = { blockId: last.id, offset: last.text.length };
      expect(scope.end).toEqual(sectionStart.get(to + 1) ?? documentEnd);
      const passages = scopePassages(blocks, scope) ?? [];
      const text = passages
        .map(({ block, start, end }) => {
          // Offsets index the page's own text, never a slice of it.
          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(block.text.length);
          expect(blocks).toContain(block);
          return block.text.slice(start, end);
        })
        .join("\n");
      expect(text.startsWith(`${String(from)}. `)).toBe(true);
      const opened = [...text.matchAll(/^(\d+)\. /gmu)].map(([, number]) =>
        Number(number),
      );
      expect(opened).toEqual(
        Array.from({ length: to - from + 1 }, (_, index) => from + index),
      );
    }),
  );
});

test("a paragraph the statement does not print is refused, never widened", () => {
  assertProperty(
    "a paragraph the statement does not print is refused, never widened",
    fc.property(statement, fc.integer({ min: 1, max: 40 }), (input, beyond) => {
      const { blocks, count } = layOut(input);
      const missing = count + beyond;
      const resolution = resolveParagraphScope(blocks, {
        from: 1,
        to: missing,
      });
      expect(resolution).toEqual({
        type: "not-found",
        numbering: "document",
        missing: [missing],
        available: { from: 1, to: count },
      });
    }),
  );
});
