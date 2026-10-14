import { expect, test } from "bun:test";
import fc from "fast-check";

import { type Block, projectPlainText } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { courtListenerValidationPolicy } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/validation-policy";

import { validateAst as validateSharedAst } from "./validate-ast";

const validateAst = (
  html: string,
  blocks: Block[],
  options?: Parameters<typeof validateSharedAst>[2],
) =>
  validateSharedAst(html, blocks, {
    ...options,
    sourcePolicy: courtListenerValidationPolicy,
  });

const paragraph = (text: string): Block => {
  const inlines = [{ type: "text", text }] as const;
  return {
    type: "paragraph",
    id: "invented",
    anchorId: "invented-paragraph",
    inlines: [...inlines],
    plainText: projectPlainText(inlines),
  };
};

test("letter spacing is compared on the canonical plain text axis", () => {
  const text = "I n v e n t e d  j u d g m e n t  a f f i r m e d";
  const block = paragraph(text);
  expect(block.plainText.length).toBeLessThan(text.length * 0.8);
  const result = validateAst(`<p>${text}</p>`, [block]);
  expect(result.stats.retainedPct).toBe(100);
  expect(result.stats.missingWords).toEqual([]);
  expect(result.issues.map(({ code }) => code)).not.toContain(
    "INLINE_PLAINTEXT_MISMATCH",
  );
  expect(result.ok).toBe(true);
});

test("canonical projection accepts letter spacing and detects lost letters", () => {
  assertProperty(
    "canonical projection accepts letter spacing and detects lost letters",
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{5,20}$/u), {
        minLength: 2,
        maxLength: 20,
      }),
      fc.constantFrom(" ", "  "),
      (words, spacing) => {
        const text = words
          .map((word) => Array.from(word).join(spacing))
          .join("\n");
        const block = paragraph(text);
        expect(block.plainText).not.toBe(text);
        const result = validateAst(`<p>${text}</p>`, [block]);
        expect(result.stats.retainedPct).toBe(100);
        expect(result.issues.map(({ code }) => code)).not.toContain(
          "INLINE_PLAINTEXT_MISMATCH",
        );
        expect(result.ok).toBe(true);

        const lost = validateAst(`<p>${text}</p>`, [paragraph("Invented")]);
        expect(lost.issues.map(({ code }) => code)).toContain("CONTENT_LOSS");
        const inconsistent = validateAst(`<p>${text}</p>`, [
          { ...block, plainText: "x" },
        ]);
        expect(inconsistent.issues.map(({ code }) => code)).toContain(
          "INLINE_PLAINTEXT_MISMATCH",
        );
      },
    ),
  );
});

test("canonical validation does not invent words across folded OCR lines", () => {
  assertProperty(
    "canonical validation does not invent words across folded OCR lines",
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{5}$/u), {
        minLength: 20,
        maxLength: 25,
      }),
      (words) => {
        const filler =
          "The invented judgment preserves complete words. ".repeat(100);
        const sourceParts = words.map(
          (word) => `Term ${Array.from(word).join("\n")} suffix.`,
        );
        const blocks = words.map((word) =>
          paragraph(`Term ${word.slice(0, 2)} ${word.slice(2)} suffix.`),
        );
        blocks.push(paragraph(filler));
        const rawText = [...sourceParts, filler].join(" ");
        const storedText = blocks.map(({ plainText }) => plainText).join(" ");
        expect(rawText.replace(/\s/gu, "")).toBe(
          storedText.replace(/\s/gu, ""),
        );
        const source = [...sourceParts, filler]
          .map((part) => `<p>${part}</p>`)
          .join("");
        const result = validateAst(source, blocks);
        expect(result.stats.missingWords).toEqual([]);
        expect(result.ok).toBe(true);
      },
    ),
    { numRuns: 20 },
  );
});
