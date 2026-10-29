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
