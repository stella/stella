/**
 * The court's paragraph numbers on decisions the publishers served.
 *
 * Every case here is a recorded document read by its court's own parser,
 * which runs `courtParagraphNumbers` as its last step: the numbers a reader,
 * a `#par=` link and a citation see are the ones asserted.
 */

import { describe, expect, test } from "bun:test";

import {
  COURT_PARAGRAPH_NUMBERING_DEFECTS,
  extractCourtParagraphNumbers,
} from "@stll/legal-ast/court-paragraph-numbers";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

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

const paragraph = (index: number, plainText: string): Block => ({
  id: `b${String(index)}`,
  anchorId: `p-${String(index)}`,
  type: "paragraph",
  inlines: [{ type: "text", text: plainText }],
  plainText,
});

describe("a list in the court's own marker style inside its numbering", () => {
  /** Court paragraphs ("court") and list items ("item"), all "N. …". */
  const read = (layout: readonly (readonly ["court" | "item", number])[]) => {
    const blocks = layout.map(([kind, number], index) =>
      paragraph(
        index,
        `${String(number)}. ${kind === "court" ? "Soud uvážil" : "Položka"} ${String(index)}.`,
      ),
    );
    const numbering = extractCourtParagraphNumbers(blocks);
    return layout.map(([kind], index) => {
      const block = numbering.blocks[index];
      return [kind, block?.type === "paragraph" ? block.number : undefined];
    });
  };

  test("keeps the court's numbers when the list runs past them", () => {
    expect(
      read([
        ["court", 1],
        ["court", 2],
        ["item", 1],
        ["item", 2],
        ["item", 3],
        ["item", 4],
        ["court", 3],
        ["court", 4],
        ["court", 5],
      ]),
    ).toEqual([
      ["court", 1],
      ["court", 2],
      ["item", undefined],
      ["item", undefined],
      ["item", undefined],
      ["item", undefined],
      ["court", 3],
      ["court", 4],
      ["court", 5],
    ]);
  });

  test("keeps the court's numbers when the list starts right after paragraph 1", () => {
    expect(
      read([
        ["court", 1],
        ["item", 1],
        ["item", 2],
        ["item", 3],
        ["court", 2],
        ["court", 3],
      ]),
    ).toEqual([
      ["court", 1],
      ["item", undefined],
      ["item", undefined],
      ["item", undefined],
      ["court", 2],
      ["court", 3],
    ]);
  });
});

describe("the hard invariants of a numbering", () => {
  const numbersOfMarked = (markers: readonly number[]) => {
    const numbering = extractCourtParagraphNumbers(
      markers.map((number, index) =>
        paragraph(
          index,
          `${String(number)}. Soud uvážil věc ${String(index)}.`,
        ),
      ),
    );
    return {
      type: numbering.type,
      numbers: numbering.blocks.map((block) =>
        block.type === "paragraph" ? (block.number ?? null) : null,
      ),
    };
  };

  test("a list after paragraph 4 keeps 1 and 2 as its items", () => {
    expect(numbersOfMarked([1, 2, 3, 4, 1, 2, 5])).toEqual({
      type: "numbered",
      numbers: [1, 2, 3, 4, null, null, 5],
    });
  });

  test("a quoted provision's lowercase points are not the court's markers", () => {
    const texts = [
      "1. Soud uvážil.",
      "2. Soud cituje zákon:",
      '"1. Německá říše a osoby veřejného práva;',
      "2. osoby fysické národnosti německé;",
      '3. osoby fysické, které vyvíjely činnost."',
      "3. Soud dále uvážil.",
    ];
    const numbering = extractCourtParagraphNumbers(
      texts.map((text, index) => paragraph(index, text)),
    );
    expect(
      numbering.blocks.map((block) =>
        block.type === "paragraph" ? (block.number ?? null) : null,
      ),
    ).toEqual([1, 2, null, null, null, 3]);
  });

  test.each([1, 2, 3, 4, 117, 118])(
    "a quoted paragraph %i cannot advance the court's sequence",
    (quotedNumber) => {
      const numbering = extractCourtParagraphNumbers(
        [
          "[1] Soud uvážil.",
          "[2] Soud uvedl: „Citace začíná.",
          `[${String(quotedNumber)}] Citace pokračuje a končí.“`,
          "[3] Soud dále uvážil.",
          "[4] Soud uzavřel.",
        ].map((text, index) => paragraph(index, text)),
      );
      expect(numbering.type).toBe("numbered");
      expect(
        numbering.blocks.map((block) =>
          block.type === "paragraph" ? (block.number ?? null) : null,
        ),
      ).toEqual([1, 2, null, 3, 4]);
    },
  );

  test("a quoted decision's paragraph numbers are not the court's", () => {
    const read = (quoted: string) =>
      extractCourtParagraphNumbers(
        [
          "[1] Soud uvážil.",
          "[2] Osmý senát uvedl:",
          `${quoted}[117] Citovaný soud rozhodl takto.`,
          "[118] Citace pokračuje a končí.“",
          "[3] Soud dále uvážil.",
        ].map((text, index) => paragraph(index, text)),
      );
    const numbers = (numbering: ReturnType<typeof read>) =>
      numbering.blocks.map((block) =>
        block.type === "paragraph" ? (block.number ?? null) : null,
      );
    // The quotation the court opened before "[117]" is still open at
    // "[118]": that number is the quoted decision's.
    expect(numbers(read("„"))).toEqual([1, 2, null, null, 3]);
    // Without the quotation, "[118]" is a marker nothing explains.
    expect(read("").type).toBe("rejected");
  });

  test.each([
    ["„ … ”", "„", "”"],
    ["» … «", "»", "«"],
  ])(
    "a quotation printed %s sets its paragraph numbers apart",
    (_, open, close) => {
      const numbering = extractCourtParagraphNumbers(
        [
          "[1] Soud uvážil.",
          "[2] Osmý senát uvedl:",
          `${open}[117] Citovaný soud rozhodl takto.`,
          `[118] Citace pokračuje a končí.${close}`,
          "[3] Soud dále uvážil.",
        ].map((text, index) => paragraph(index, text)),
      );
      expect(
        numbering.blocks.map((block) =>
          block.type === "paragraph" ? (block.number ?? null) : null,
        ),
      ).toEqual([1, 2, null, null, 3]);
    },
  );

  test.each([
    // Closed by a straight quote, which closes no Czech quotation.
    ['[4] Soud cituje: „Takto rozhodl."', "[5] Soud uvážil."],
    // Closed by the other pair's mark.
    ["[4] Soud cituje: „Takto rozhodl.«", "[5] Soud uvážil."],
  ])(
    "an unmatched quotation leaves the court's markers its own: %s",
    (quoting, next) => {
      const numbering = extractCourtParagraphNumbers(
        [
          "[1] Soud uvážil.",
          "[2] Soud uvážil dále.",
          "[3] Soud uvážil znovu.",
          quoting,
          next,
          "[6] Soud uvážil naposledy.",
          "[4] Soud se vrací.",
        ].map((text, index) => paragraph(index, text)),
      );
      // "[4]" after "[6]" goes backwards; no quotation explains it.
      expect(numbering.type).toBe("rejected");
    },
  );

  test("consecutive lists that could own the court's next number reject the decision", () => {
    // Court 1, 2; list 1-3; list 1-2; court 3, 4, 5; list 1-2; court 6. The
    // first list's 3 could be the court's 3 with the second list following
    // it; nothing settles it, so nothing is stored.
    expect(
      numbersOfMarked([1, 2, 1, 2, 3, 1, 2, 3, 4, 5, 1, 2, 6]).type,
    ).not.toBe("numbered");
  });

  test("a short decision with many lowercase points and an instruction keeps its numbering", () => {
    const texts = [
      "1. Soud zjistil, že žalobce uplatnil tyto nároky:",
      "a) náhradu škody,",
      "b) ušlý zisk,",
      "c) úroky z prodlení.",
      "2. Soud vyšel z těchto ustanovení:",
      "1. osoby, které vyvíjely činnost,",
      "2. osoby, které ji podporovaly.",
      "3. Žaloba je důvodná.",
      "Poučení: Proti tomuto rozsudku lze podat odvolání.",
      "Odvolání se podává u soudu prvního stupně.",
      "Lhůta k odvolání činí 15 dnů.",
      "Nesplní-li povinný dobrovolně, co mu ukládá rozhodnutí, lze podat návrh na výkon.",
    ];
    const numbering = extractCourtParagraphNumbers(
      texts.map((text, index) => paragraph(index, text)),
    );
    expect(
      numbering.blocks.flatMap((block) =>
        block.type === "paragraph" && block.number !== undefined
          ? [block.number]
          : [],
      ),
    ).toEqual([1, 2, 3]);
  });

  test("a short list opening an unnumbered reasoning stays text", () => {
    const texts = [
      "1. Žalobce podal žalobu.",
      "2. Žalovaný se nevyjádřil.",
      "Soud provedl dokazování listinami.",
      "Soud zjistil tento skutkový stav.",
      "Podle § 1 o. z. soud věc posoudil.",
      "Žaloba je proto důvodná.",
      "O nákladech řízení soud rozhodl podle § 142 o. s. ř.",
    ];
    const numbering = extractCourtParagraphNumbers(
      texts.map((text, index) => paragraph(index, text)),
    );
    expect(numbering.type).toBe("unnumbered");
  });

  test("a forward skip the court made is kept as printed", () => {
    expect(numbersOfMarked([1, 2, 3, 5, 6, 7])).toEqual({
      type: "numbered",
      numbers: [1, 2, 3, 5, 6, 7],
    });
  });

  test("a number the court printed twice rejects the decision", () => {
    expect(numbersOfMarked([1, 2, 3, 3, 4, 5])).toEqual({
      type: "rejected",
      numbers: [null, null, null, null, null, null],
    });
  });

  test("a number that could be the court's or the list's rejects the decision", () => {
    // Court 1, 2, then 1-4 to the end: either a list of four, or a list of
    // two and the court's 3 and 4. Nothing later tells them apart.
    expect(numbersOfMarked([1, 2, 1, 2, 3, 4])).toEqual({
      type: "rejected",
      numbers: [null, null, null, null, null, null],
    });
  });

  test("a numbering that looks rising but leaves the court's own markers unassigned is rejected", () => {
    // Read greedily, the list's 3 and 4 would take the court's numbers and
    // the court's own "3." and "4." would be left over.
    const { type } = numbersOfMarked([1, 2, 1, 2, 3, 4, 3, 4, 5]);
    expect(type).toBe("numbered");
    expect(numbersOfMarked([1, 2, 1, 2, 3, 4, 3, 4, 5]).numbers).toEqual([
      1,
      2,
      null,
      null,
      null,
      null,
      3,
      4,
      5,
    ]);
    // A stray the walk cannot place, between the court's 3 and 4, rejects.
    expect(numbersOfMarked([1, 2, 3, 2, 4, 5]).type).toBe("rejected");
  });
});

describe("implausible numbering", () => {
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

  test("a run of spaces after the marker does not let a date or a point through", () => {
    for (const gap of ["  ", "\t ", " ", "   "]) {
      const dates = [
        `12.${gap}3. 2020 podal žalobce odvolání.`,
        `13.${gap}3. 2020 soud rozhodl.`,
      ].map((text, index) => paragraph(index, text));
      expect({ gap, type: extractCourtParagraphNumbers(dates).type }).toEqual({
        gap,
        type: "unnumbered",
      });

      const texts = [
        `1.${gap}Soud uvážil.`,
        `2.${gap}Soud cituje zákon:`,
        `"1.${gap}Německá říše a osoby veřejného práva;`,
        `2.${gap}osoby fysické národnosti německé;`,
        `[1]${gap}osoby fysické, které vyvíjely činnost."`,
        `3.${gap}Soud dále uvážil.`,
      ];
      const numbering = extractCourtParagraphNumbers(
        texts.map((text, index) => paragraph(index, text)),
      );
      expect({
        gap,
        numbers: numbering.blocks.map((block) =>
          block.type === "paragraph" ? (block.number ?? null) : null,
        ),
        texts: numbering.blocks.map((block) =>
          block.type === "paragraph" ? block.plainText : null,
        ),
      }).toEqual({
        gap,
        numbers: [1, 2, null, null, null, 3],
        texts: [
          "Soud uvážil.",
          "Soud cituje zákon:",
          texts[2] ?? null,
          texts[3] ?? null,
          texts[4] ?? null,
          "Soud dále uvážil.",
        ],
      });
    }
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
