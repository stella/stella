import { describe, expect, test } from "bun:test";

import type { Paragraph } from "@stll/docx-core/model";
import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core";
import {
  applyFolioAIEditsToBuffer,
  createBilingualDocx,
  docxToMarkdown,
  readBilingualDocx,
} from "@stll/folio-core/server";

import { buildOperations } from "@/api/lib/bilingual/operations";
import type { StoredRow } from "@/api/lib/bilingual/operations";
import { flattenBilingualRows } from "@/api/lib/bilingual/rows";

const paragraph = (text: string, styleId = "Normal"): Paragraph => ({
  type: "paragraph",
  formatting: { styleId },
  content: [{ type: "run", formatting: {}, content: [{ type: "text", text }] }],
});

const structuralColumnBreak = (): Paragraph => ({
  type: "paragraph",
  content: [
    {
      type: "run",
      content: [{ type: "break", breakType: "column" }],
    },
  ],
});

/** A clause, a heading, a signature label, and a signature table. */
const buildBilingual = async () => {
  const doc = createEmptyDocument({
    preset: createStellaStyleDocumentPreset(),
  });
  doc.package.document.content = [
    paragraph("Předmět smlouvy", "ClauseHeading1"),
    paragraph("Smlouva se uzavírá na dobu 24 měsíců.", "ClauseParagraph1"),
    paragraph("Podpis:"),
    {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            { type: "tableCell", content: [paragraph("Jméno:")] },
            { type: "tableCell", content: [paragraph("Ing. Jan Novák")] },
          ],
        },
      ],
    },
  ];
  const { buffer } = await createBilingualDocx(await createDocx(doc), {
    targetStyleSuffix: "en",
  });
  return buffer;
};

describe("buildOperations applied to a bilingual document", () => {
  test("translates, keeps, and inlines rows; kept tables are edited in place", async () => {
    const buffer = await buildBilingual();
    const { units } = flattenBilingualRows(await readBilingualDocx(buffer));
    expect(units.map((unit) => unit.sourceText)).toEqual([
      "Předmět smlouvy",
      "Smlouva se uzavírá na dobu 24 měsíců.",
      "Podpis:",
      "Jméno:",
      "Ing. Jan Novák",
    ]);

    const dispositions = [
      "translate",
      "translate",
      "inline",
      "inline",
      "keep",
    ] as const;
    const rowIdAt = (index: number): string => {
      const unit = units[index];
      if (!unit) {
        throw new Error(`fixture has no row ${index}`);
      }
      return unit.rowId;
    };
    const translations = new Map<string, string>([
      [rowIdAt(0), "Subject matter"],
      [rowIdAt(1), "The Agreement is concluded for 24 months."],
      [rowIdAt(2), "Signature:"],
      [rowIdAt(3), "Name:"],
    ]);
    const rows: StoredRow[] = [];
    for (const [index, unit] of units.entries()) {
      const disposition = dispositions[index];
      if (!disposition) {
        throw new Error("fixture mismatch");
      }
      rows.push({
        rowId: unit.rowId,
        ordinal: unit.ordinal,
        kind: unit.kind,
        inTable: unit.inTable,
        sourceParaId: unit.sourceParaId,
        sourceText: unit.sourceText,
        disposition,
        targetText: translations.get(unit.rowId) ?? null,
        status: translations.has(unit.rowId) ? "translated" : "pending",
      });
    }

    const operations = buildOperations(rows, translations);
    const applied = await applyFolioAIEditsToBuffer(buffer, operations, {
      author: "test",
      mode: "direct",
    });
    expect(applied.skipped).toEqual([]);

    const markdown = await docxToMarkdown(applied.buffer);
    // Translated pair rows: source left, translation right.
    expect(markdown).toContain("Subject matter");
    expect(markdown).toContain("The Agreement is concluded for 24 months.");
    expect(markdown).toContain("Předmět smlouvy");
    // Inline label merged into one cell, shown once with both languages.
    expect(markdown).toContain("Podpis: / Signature:");
    expect(markdown.match(/Podpis:/gu)).toHaveLength(1);
    // Kept table: label inlined, value untouched and not duplicated.
    expect(markdown).toContain("Jméno: / Name:");
    expect(markdown.match(/Ing\. Jan Novák/gu)).toHaveLength(1);

    // The merged row is no longer a left | right pair.
    const after = await readBilingualDocx(applied.buffer);
    const pairTexts = after.flatMap((row) =>
      row.kind === "table" ? [] : [row.sourceText],
    );
    expect(pairTexts).toEqual([
      "Předmět smlouvy",
      "Smlouva se uzavírá na dobu 24 měsíců.",
    ]);
  });

  test("never merges a row whose translation is missing", () => {
    const row: StoredRow = {
      rowId: "right",
      ordinal: 1,
      kind: "paragraph",
      inTable: false,
      sourceParaId: "left",
      sourceText: "Podpis:",
      disposition: "inline",
      targetText: null,
      status: "failed",
    };
    expect(buildOperations([row], new Map())).toEqual([]);
    expect(
      buildOperations([{ ...row, disposition: "translate" }], new Map()),
    ).toEqual([]);
  });

  test("only builds operations for rows present in Folio's editable snapshot", async () => {
    const doc = createEmptyDocument({
      preset: createStellaStyleDocumentPreset(),
    });
    doc.package.document.content = [
      paragraph("Before"),
      structuralColumnBreak(),
      paragraph("After"),
    ];
    const { buffer } = await createBilingualDocx(await createDocx(doc), {
      targetStyleSuffix: "en",
    });
    const { dropped, units } = flattenBilingualRows(
      await readBilingualDocx(buffer),
    );
    expect(dropped).toBe(0);
    expect(units.map(({ sourceText }) => sourceText)).toEqual([
      "Before",
      "After",
    ]);

    const rows: StoredRow[] = [];
    for (const unit of units) {
      rows.push({
        disposition: "keep",
        inTable: unit.inTable,
        kind: unit.kind,
        ordinal: unit.ordinal,
        rowId: unit.rowId,
        sourceParaId: unit.sourceParaId,
        sourceText: unit.sourceText,
        status: "pending",
        targetText: null,
      });
    }
    const operations = buildOperations(rows, new Map());
    const applied = await applyFolioAIEditsToBuffer(buffer, operations, {
      author: "test",
      mode: "direct",
    });

    expect(applied.skipped).toEqual([]);
  });
});
