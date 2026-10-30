import { expect, test } from "bun:test";

import { validateAst } from "./validate-ast";

test("anonymization brackets retain pre-reuse Greek final sigma diagnostics", () => {
  const result = validateAst("<p>ΛΟΓΟ[Σ]</p>", [
    {
      type: "paragraph",
      id: "generated",
      anchorId: "greek-word",
      inlines: [{ type: "text", text: "ΛΟΓΟΣ" }],
      plainText: "ΛΟΓΟΣ",
    },
  ]);

  expect(result.stats.missingWords).toEqual(["λογοσ"]);
  expect(result.issues.some(({ code }) => code === "MISSING_WORDS")).toBe(
    false,
  );
});

test("retention length includes characters introduced by lowercasing", () => {
  const source = `${"İ".repeat(30)} abcd`;
  const result = validateAst(`<p>${source}</p>`, [
    {
      type: "paragraph",
      id: "generated",
      anchorId: "expanded-lowercase",
      inlines: [{ type: "text", text: "İ".repeat(30) }],
      plainText: "İ".repeat(30),
    },
  ]);

  expect(result.stats.originalLength).toBe(65);
  expect(result.stats.astLength).toBe(60);
  expect(result.stats.retainedPct).toBe(92.3);
  expect(result.issues.some(({ code }) => code === "CONTENT_LOSS")).toBe(false);
});

test("publisher fragments account only for complete words whose letters remain", () => {
  const source = {
    type: "paragraphs",
    paragraphs: ["rozh od ol O d ôvod n eni e Pou čen i e vyl účen ý"],
  } as const;
  const text = "rozhodol Odôvodnenie Poučenie vylúčený";
  const blocks = [
    {
      type: "paragraph" as const,
      id: "p1",
      anchorId: "p1",
      inlines: [{ type: "text" as const, text }],
      plainText: text,
    },
  ];
  expect(validateAst(source, blocks).stats.missingWords.length).toBeGreaterThan(
    0,
  );
  expect(
    validateAst(source, blocks, {
      wordBoundaries: "publisher-fragments",
      maxMissingWords: 0,
    }).stats.missingWords,
  ).toEqual([]);
  const missing = text.replace("rozhodol", "rozhol");
  const damaged = [
    {
      type: "paragraph" as const,
      id: "p1",
      anchorId: "p1",
      inlines: [{ type: "text" as const, text: missing }],
      plainText: missing,
    },
  ];
  const lost = validateAst(source, damaged, {
    wordBoundaries: "publisher-fragments",
    maxMissingWords: 0,
  });
  expect(lost.stats.missingWords).toContain("rozh");
  expect(lost.issues.some((issue) => issue.code === "MISSING_WORDS")).toBe(
    true,
  );
});

test.each([
  { source: "after noon afternoon", ast: "afternoon", missing: "after" },
  { source: "case case l a w", ast: "caselaw", missing: "case" },
  { source: "after, noon", ast: "afternoon", missing: "after" },
])(
  "fragment comparison preserves missing source words in $source",
  ({ source, ast, missing }) => {
    const retained =
      " The judgment records the appeal and the reasons in its closing paragraph.".repeat(
        20,
      );
    const text = ast + retained;
    const result = validateAst(
      { type: "paragraphs", paragraphs: [source + retained] },
      [
        {
          type: "paragraph",
          id: "p1",
          anchorId: "p1",
          inlines: [{ type: "text", text }],
          plainText: text,
        },
      ],
      { wordBoundaries: "publisher-fragments", maxMissingWords: 0 },
    );
    expect(result.stats.retainedPct).toBeGreaterThan(90);
    expect(result.stats.missingWords).toContain(missing);
    expect(result.issues.some((issue) => issue.code === "MISSING_WORDS")).toBe(
      true,
    );
  },
);

test("fragment comparison also reads a character-preserving explicit word comparison", () => {
  const text = "Alpha Beta";
  const result = validateAst(
    { type: "paragraphs", paragraphs: ["AlphaBeta"] },
    [
      {
        type: "paragraph",
        id: "p1",
        anchorId: "p1",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
    { wordComparisonText: text, wordBoundaries: "publisher-fragments" },
  );
  expect(result.stats.missingWords).toEqual([]);
});
