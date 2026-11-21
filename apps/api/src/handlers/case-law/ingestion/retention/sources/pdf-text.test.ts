import { PDF } from "@libpdf/core";
import { describe, expect, spyOn, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import {
  PDF_PROJECTION_MAX_BYTES,
  projectPdfText,
} from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

/** Words the typesetter broke at a line end, each into its two halves. */
const BROKEN_WORDS = [
  ["administr", "ation"],
  ["consider", "ation"],
  ["juris", "diction"],
  ["applic", "ation"],
  ["proceed", "ings"],
  ["regul", "ation"],
  ["compens", "ation"],
  ["respond", "ent"],
  ["appell", "ant"],
  ["evid", "ence"],
  ["testi", "mony"],
  ["argu", "ments"],
  ["inter", "pretation"],
  ["legis", "lature"],
  ["consti", "tution"],
  ["judg", "ment"],
  ["juris", "prudence"],
  ["obli", "gation"],
  ["liab", "ility"],
  ["settle", "ment"],
] as const;

/** One PDF line ending in each broken half, the next continuing it. */
const LINES = BROKEN_WORDS.flatMap(([head, tail], index) => [
  `Paragraph ${index + 1} of the court concerns the ${head}-`,
  `${tail} the parties brought before it.`,
]);

const pdfOf = async (lines: readonly string[]): Promise<Uint8Array> => {
  const pdf = PDF.create();
  for (let start = 0; start < lines.length; start += 30) {
    const page = pdf.addPage({ size: "a4" });
    for (const [index, line] of lines.slice(start, start + 30).entries()) {
      page.drawText(line, { x: 56, y: 790 - index * 24, size: 10 });
    }
  }
  return await pdf.save();
};

const paragraph = (index: number, text: string): Block => ({
  id: `p${index}`,
  anchorId: `p${index}`,
  type: "paragraph",
  plainText: text,
  inlines: [{ type: "text", text }],
});

/** A parse that rejoins each broken word, as a reader reads it. */
const rejoined = BROKEN_WORDS.map(([head, tail], index) =>
  paragraph(
    index,
    `Paragraph ${index + 1} of the court concerns the ${head}${tail} the parties brought before it.`,
  ),
);

/** A parse that keeps each break as the file prints it. */
const keptSplit = BROKEN_WORDS.map(([head, tail], index) =>
  paragraph(
    index,
    `Paragraph ${index + 1} of the court concerns the ${head}- ${tail} the parties brought before it.`,
  ),
);

describe("projectPdfText", () => {
  test("either faithful reading of a line-end break is complete", async () => {
    const projection = await projectPdfText(await pdfOf(LINES));
    if (projection.type !== "source") {
      throw new Error(`projection answered ${projection.type}`);
    }
    for (const blocks of [rejoined, keptSplit]) {
      const result = validateAst(projection.source, blocks, projection.options);
      expect(result.ok, `missing ${result.stats.missingWords.join(", ")}`).toBe(
        true,
      );
    }
  });

  test("a parse that lost the broken words still reads as lost", async () => {
    const projection = await projectPdfText(await pdfOf(LINES));
    if (projection.type !== "source") {
      throw new Error(`projection answered ${projection.type}`);
    }
    const lost = BROKEN_WORDS.map((_, index) =>
      paragraph(
        index,
        `Paragraph ${index + 1} of the court concerns the parties brought before it.`,
      ),
    );
    expect(validateAst(projection.source, lost, projection.options).ok).toBe(
      false,
    );
  });

  test("PDF projection never parses in the writer process at either input size", async () => {
    const inputs = await Promise.all(
      [1, 10].map(
        async (size) =>
          await pdfOf(Array.from({ length: size }, () => LINES).flat()),
      ),
    );
    const parentParse = spyOn(PDF, "load").mockImplementation(() => {
      throw new TypeError("PDF parsing ran in the writer process");
    });
    try {
      for (const bytes of inputs) {
        expect((await projectPdfText(bytes)).type).toBe("source");
        expect(parentParse).not.toHaveBeenCalled();
      }
    } finally {
      parentParse.mockRestore();
    }
  });

  test("a file over the budget is left unchecked without being read", async () => {
    expect(
      await projectPdfText(new Uint8Array(PDF_PROJECTION_MAX_BYTES + 1)),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET,
    });
  });
});
