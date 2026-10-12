/**
 * The court's paragraph numbers on decisions the publishers served.
 *
 * Every case here is a recorded document read by its court's own parser,
 * which runs `courtParagraphNumbers` as its last step: the numbers a reader,
 * a `#par=` link and a citation see are the ones asserted.
 */

import { describe, expect, test } from "bun:test";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

import {
  COURT_PARAGRAPH_NUMBERING_DEFECTS,
  extractCourtParagraphNumbers,
} from "@/api/handlers/case-law/ingestion/parsers/court-paragraph-numbers";
import {
  type EvidenceDocument,
  PROCESSED_FIELD_EVIDENCE_READERS,
} from "@/api/tests/helpers/processed-field-evidence";

const ADAPTERS = "src/handlers/case-law/ingestion/adapters/__fixtures__/";
const PARSERS = "src/handlers/case-law/ingestion/parsers/__fixtures__/";

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const numbersOf = (ast: DocumentAst): number[] =>
  ast.blocks.flatMap((block) =>
    block.type === "paragraph" && block.number !== undefined
      ? [block.number]
      : [],
  );

/** Body paragraphs (not footnotes) whose text opens with `pattern`. */
const paragraphsOpeningWith = (ast: DocumentAst, pattern: RegExp) =>
  ast.blocks.filter(
    (block) =>
      block.type === "paragraph" &&
      block.note === undefined &&
      pattern.test(block.plainText),
  );

const only = async (
  documents: Promise<readonly EvidenceDocument[]>,
): Promise<DocumentAst> => {
  const [document, ...rest] = await documents;
  expect(rest).toEqual([]);
  if (document === undefined) {
    throw new Error("the recording holds no decision");
  }
  return document.ast;
};

const readNs = async () => {
  const documents = await PROCESSED_FIELD_EVIDENCE_READERS["cz-ns"](
    `${ADAPTERS}cz-ns-page.json.gz`,
  );
  return new Map(
    documents.map(({ id, ast }) => [id.slice(id.indexOf("#") + 1), ast]),
  );
};

describe("Nejvyšší soud", () => {
  test("numbers '1.' / '[1]' / '1)' reasoning and leaves the marker out of the text", async () => {
    const decisions = await readNs();
    const expected: Record<string, number[]> = {
      "6 Tdo 647/2017": range(1, 15),
      "26 Cdo 650/2025": range(1, 13),
      "8 Tdo 88/2017": range(1, 26),
      "27 Cdo 2709/2017": range(1, 44),
      "27 Cdo 3366/2021": range(1, 34),
      // The court skipped 5; the decision is cited by the numbers it prints.
      "5 Tdo 28/2024": [...range(1, 4), ...range(6, 30)],
    };
    for (const [caseNumber, numbers] of Object.entries(expected)) {
      const ast = decisions.get(caseNumber);
      expect({ caseNumber, numbers: ast && numbersOf(ast) }).toEqual({
        caseNumber,
        numbers,
      });
    }
    const first = decisions
      .get("6 Tdo 647/2017")
      ?.blocks.find(
        (block) => block.type === "paragraph" && block.number === 1,
      );
    expect(first?.plainText.startsWith("Rozsudkem Okresního soudu")).toBe(true);
    // Every other recorded decision is an older, unnumbered one.
    const unnumbered = [...decisions].filter(
      ([caseNumber, ast]) =>
        !(caseNumber in expected) && numbersOf(ast).length > 0,
    );
    expect(unnumbered.map(([caseNumber]) => caseNumber)).toEqual([]);
  });

  test("a list inside a numbered paragraph keeps its own markers as text", async () => {
    const ast = (await readNs()).get("27 Cdo 2709/2017");
    if (ast === undefined) {
      throw new Error("missing 27 Cdo 2709/2017");
    }
    const items = paragraphsOpeningWith(ast, /^\d{1,2}\)\t/u);
    expect(items.length).toBeGreaterThanOrEqual(14);
    expect(
      items.every(
        (block) => block.type === "paragraph" && block.number === undefined,
      ),
    ).toBe(true);
  });

  test("enumerations in an unnumbered decision are not taken for paragraph numbers", async () => {
    const decisions = await readNs();
    for (const [caseNumber, marker] of [
      ["22 Cdo 5441/2015", /^1\.\tPro zohlednění/u],
      ["29 Odo 756/2005", /^1\) Zda právo člena/u],
      ["29 Cdo 3633/2007", /^1\/ K možnosti/u],
    ] as const) {
      const ast = decisions.get(caseNumber);
      if (ast === undefined) {
        throw new Error(`missing ${caseNumber}`);
      }
      expect({ caseNumber, numbers: numbersOf(ast) }).toEqual({
        caseNumber,
        numbers: [],
      });
      expect(paragraphsOpeningWith(ast, marker).length).toBeGreaterThan(0);
    }
  });
});

describe("Nejvyšší správní soud", () => {
  test("numbers every [N] paragraph, and nothing else", async () => {
    const ast = await only(
      PROCESSED_FIELD_EVIDENCE_READERS["cz-nss"](
        `${PARSERS}cz-nss-10-as-124-2025.html.gz`,
      ),
    );
    expect(numbersOf(ast)).toEqual(range(1, 82));
    expect(paragraphsOpeningWith(ast, /^\[\d+\]/u)).toEqual([]);
    // The court numbers its arguments' headings "1. …"; they are headings in
    // the text, not paragraphs of the numbering.
    const heading = paragraphsOpeningWith(
      ast,
      /^1\. Pořizování územního plánu/u,
    );
    expect(heading).toHaveLength(1);
    expect(heading[0]).not.toHaveProperty("number");
    // Footnotes print "[1]" too, and are never body paragraphs.
    const notes = ast.blocks.filter(
      (block) => block.type === "paragraph" && block.note !== undefined,
    );
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((block) => !("number" in block))).toBe(true);
  });

  test("a short order is numbered and its holdings are not", async () => {
    const ast = await only(
      PROCESSED_FIELD_EVIDENCE_READERS["cz-nss"](
        `${PARSERS}cz-nss-22-as-35-2026.html.gz`,
      ),
    );
    expect(numbersOf(ast)).toEqual(range(1, 14));
    const holdings = ast.blocks.filter(
      (block) => block.type === "paragraph" && block.role === "holding",
    );
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.every((block) => !("number" in block))).toBe(true);
  });
});

describe("Ústavní soud", () => {
  test("recovers the 'N.' numbers the parser used to drop", async () => {
    for (const [fixture, last] of [
      ["cz-us-iv-us-422-26.html.gz", 22],
      ["cz-us-iii-us-2429-24.html.gz", 27],
    ] as const) {
      const ast = await only(
        PROCESSED_FIELD_EVIDENCE_READERS["cz-us"](`${PARSERS}${fixture}`),
      );
      expect({ fixture, numbers: numbersOf(ast) }).toEqual({
        fixture,
        numbers: range(1, last),
      });
      expect(paragraphsOpeningWith(ast, /^\d{1,3}\. /u)).toEqual([]);
    }
  });

  test("the 1993 decisions, which print no numbers, stay unnumbered", async () => {
    const documents = await PROCESSED_FIELD_EVIDENCE_READERS["cz-us"](
      `${ADAPTERS}cz-us-page.json.gz`,
    );
    expect(documents.length).toBeGreaterThan(30);
    expect(documents.filter(({ ast }) => numbersOf(ast).length > 0)).toEqual(
      [],
    );
  });
});

describe("regional courts and the Slovak Constitutional Court", () => {
  test("number their reasoning", async () => {
    for (const [reader, fixture, last] of [
      ["cz-regional", `${ADAPTERS}cz-regional-finaldoc-district.json.gz`, 11],
      ["cz-regional", `${ADAPTERS}cz-regional-finaldoc-appellate.json.gz`, 10],
      ["sk-us", `${PARSERS}sk-us-iii-us-265-2026.content.json.gz`, 14],
    ] as const) {
      const ast = await only(PROCESSED_FIELD_EVIDENCE_READERS[reader](fixture));
      expect({ fixture, numbers: numbersOf(ast) }).toEqual({
        fixture,
        numbers: range(1, last),
      });
    }
  });
});

describe("implausible numbering", () => {
  const paragraph = (index: number, plainText: string): Block => ({
    id: `b${String(index)}`,
    anchorId: `p-${String(index)}`,
    type: "paragraph",
    inlines: [{ type: "text", text: plainText }],
    plainText,
  });

  test("is rejected with its defect and leaves every marker in the text", () => {
    const blocks = [1, 2, 3, 9, 14, 2, 30, 31, 7].map((number, index) =>
      paragraph(index, `${String(number)}. Soud posoudil věc znovu.`),
    );
    const numbering = extractCourtParagraphNumbers(blocks);
    expect(numbering).toMatchObject({
      type: "rejected",
      defect: COURT_PARAGRAPH_NUMBERING_DEFECTS.IRREGULAR_SEQUENCE,
    });
    expect(numbering.blocks).toEqual(blocks);
  });

  test("a date opening a paragraph is not a number", () => {
    const blocks = [
      "12. 3. 2020 podal žalobce odvolání.",
      "13. 3. 2020 soud rozhodl.",
    ].map((text, index) => paragraph(index, text));
    expect(extractCourtParagraphNumbers(blocks).type).toBe("unnumbered");
  });
});

describe("#par= links on Czech decisions", () => {
  test("resolve to the paragraphs the court numbered", async () => {
    const ast = await only(
      PROCESSED_FIELD_EVIDENCE_READERS["cz-nss"](
        `${PARSERS}cz-nss-22-as-35-2026.html.gz`,
      ),
    );
    const resolution = resolveDecisionParagraphRange(ast, { from: 3, to: 5 });
    expect(resolution.type).toBe("found");
    if (resolution.type !== "found") {
      return;
    }
    const targets = resolution.anchorIds.map((anchorId) =>
      ast.blocks.find((block) => block.anchorId === anchorId),
    );
    expect(
      targets.map((block) =>
        block?.type === "paragraph" ? block.number : null,
      ),
    ).toEqual([3, 4, 5]);
    expect(resolveDecisionParagraphRange(ast, { from: 13, to: 16 })).toEqual({
      type: "not-found",
      missing: [15, 16],
    });
  });
});
