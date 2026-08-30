import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

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

import {
  applyFormattedBilingualTranslations,
  BilingualFormattingError,
  extractFormattedBilingualUnits,
} from "@/api/lib/bilingual/formatting";
import {
  buildFormattingPreservingOperations,
  buildOperations,
} from "@/api/lib/bilingual/operations";
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

const mixedFormattingParagraph = (label: string): Paragraph => ({
  type: "paragraph",
  formatting: { styleId: "Normal" },
  content: [
    {
      type: "run",
      formatting: { bold: true },
      content: [{ type: "text", text: `${label} bold` }],
    },
    {
      type: "run",
      formatting: { italic: true },
      content: [{ type: "text", text: " italic" }, { type: "tab" }],
    },
    {
      type: "run",
      formatting: {
        highlight: "yellow",
        underline: { style: "single" },
      },
      content: [
        { type: "text", text: " underlined" },
        { type: "break", breakType: "textWrapping" },
        { type: "symbol", font: "Wingdings", char: "F0FC" },
      ],
    },
    {
      type: "run",
      content: [
        { type: "fieldChar", charType: "begin" },
        { type: "instrText", text: " PAGE " },
        { type: "fieldChar", charType: "separate" },
        { type: "text", text: "1" },
        { type: "fieldChar", charType: "end" },
      ],
    },
  ],
});

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";

const paragraphSignature = async (
  buffer: ArrayBuffer,
  paraId: string,
): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) {
    throw new Error("fixture has no document part");
  }
  const doc = slimdom.parseXmlDocument(xml);
  const candidateParagraph = [...doc.getElementsByTagNameNS(W_NS, "p")].find(
    (candidate) => candidate.getAttributeNS(W14_NS, "paraId") === paraId,
  );
  if (!candidateParagraph) {
    throw new Error(`fixture has no paragraph ${paraId}`);
  }
  return [...candidateParagraph.childNodes]
    .filter((child) => child.nodeType === child.ELEMENT_NODE)
    .map((child) => slimdom.serializeToWellFormedString(child))
    .join("");
};

const wordElementCount = (xml: string, localName: string): number =>
  [...xml.matchAll(new RegExp(`<w:${localName}(?:\\s|/|>)`, "gu"))].length;

const addExtendedInlineControls = async (
  buffer: ArrayBuffer,
): Promise<ArrayBuffer> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) {
    throw new Error("fixture has no document part");
  }
  const marker = /(<w:t\b[^>]*> italic<\/w:t>)/gu;
  if (!marker.test(xml)) {
    throw new Error("fixture has no italic text marker");
  }
  zip.file(
    "word/document.xml",
    xml.replaceAll(marker, "$1<w:cr/><w:noBreakHyphen/><w:softHyphen/>"),
  );
  return await zip.generateAsync({ type: "arraybuffer" });
};

const addParagraphPropertyTabStop = async (
  buffer: ArrayBuffer,
  paraId: string,
): Promise<ArrayBuffer> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) {
    throw new Error("fixture has no document part");
  }
  const doc = slimdom.parseXmlDocument(xml);
  const candidateParagraph = [...doc.getElementsByTagNameNS(W_NS, "p")].find(
    (candidate) => candidate.getAttributeNS(W14_NS, "paraId") === paraId,
  );
  const paragraphProperties = candidateParagraph
    ? [...candidateParagraph.getElementsByTagNameNS(W_NS, "pPr")].at(0)
    : undefined;
  if (!paragraphProperties) {
    throw new Error(`fixture paragraph ${paraId} has no properties`);
  }
  const tabs = doc.createElementNS(W_NS, "w:tabs");
  const tab = doc.createElementNS(W_NS, "w:tab");
  tab.setAttributeNS(W_NS, "w:val", "left");
  tab.setAttributeNS(W_NS, "w:pos", "720");
  tabs.append(tab);
  paragraphProperties.append(tabs);
  zip.file("word/document.xml", slimdom.serializeToWellFormedString(doc));
  return await zip.generateAsync({ type: "arraybuffer" });
};

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
  });

  test("translates only the target copy of a stacked source table", async () => {
    const doc = createEmptyDocument({
      preset: createStellaStyleDocumentPreset(),
    });
    doc.package.document.content = [
      {
        type: "table",
        rows: [
          {
            type: "tableRow",
            cells: [
              { type: "tableCell", content: [paragraph("Name:")] },
              { type: "tableCell", content: [paragraph("Acme Ltd")] },
            ],
          },
        ],
      },
    ];
    const bilingual = await createBilingualDocx(await createDocx(doc), {
      targetStyleSuffix: "es",
      tableLayout: "stacked",
    });
    const { units } = flattenBilingualRows(
      await readBilingualDocx(bilingual.buffer),
    );
    const label = units.at(0);
    const value = units.at(1);
    if (!label || !value || label.sourceParaId === null) {
      throw new Error("stacked table fixture is incomplete");
    }
    expect(label.rowId).not.toBe(label.sourceParaId);

    const rows: StoredRow[] = [
      {
        ...label,
        disposition: "inline",
        status: "translated",
        targetText: "Nombre:",
      },
      {
        ...value,
        disposition: "keep",
        status: "pending",
        targetText: null,
      },
    ];
    expect(buildOperations(rows, new Map([[label.rowId, "Nombre:"]]))).toEqual([
      {
        id: "bilingual-1",
        type: "replaceBlock",
        blockId: label.rowId,
        text: "Nombre:",
        preserveFormatting: true,
      },
    ]);

    const formatted = await extractFormattedBilingualUnits(
      bilingual.buffer,
      units,
    );
    const formattedLabel = formatted.at(0);
    if (!formattedLabel || formattedLabel.spans.length === 0) {
      throw new Error("stacked label fixture has no formatted span");
    }
    const translatedSpans = formattedLabel.spans.map(({ id }, index) => ({
      id,
      text: index === 0 ? "Nombre:" : "",
    }));
    const output = await applyFormattedBilingualTranslations(
      bilingual.buffer,
      rows,
      new Map([
        [
          label.rowId,
          {
            text: translatedSpans.map(({ text }) => text).join(""),
            spans: translatedSpans,
          },
        ],
      ]),
    );
    const markdown = await docxToMarkdown(output);

    expect(markdown).toContain("Name:");
    expect(markdown).toContain("Nombre:");
    expect(markdown).not.toContain("Name: / Nombre:");
    expect(markdown.match(/Name:/gu)).toHaveLength(1);
    expect(markdown.match(/Acme Ltd/gu)).toHaveLength(2);
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

  test("preserves mixed inline formatting and controls in translated and inline rows", async () => {
    const doc = createEmptyDocument({
      preset: createStellaStyleDocumentPreset(),
    });
    doc.package.document.content = [
      mixedFormattingParagraph("Clause"),
      mixedFormattingParagraph("Signature"),
      {
        type: "table",
        rows: [
          {
            type: "tableRow",
            cells: [
              {
                type: "tableCell",
                content: [mixedFormattingParagraph("Name")],
              },
            ],
          },
        ],
      },
    ];
    const bilingual = await createBilingualDocx(await createDocx(doc), {
      targetStyleSuffix: "en",
    });
    const buffer = await addExtendedInlineControls(bilingual.buffer);
    const { units } = flattenBilingualRows(await readBilingualDocx(buffer));
    const clause = units.at(0);
    const signature = units.at(1);
    const tableLabel = units.at(2);
    if (
      !clause ||
      !signature ||
      !tableLabel ||
      signature.sourceParaId === null
    ) {
      throw new Error("fixture bilingual rows are incomplete");
    }
    const rows: StoredRow[] = [
      {
        ...clause,
        disposition: "translate",
        status: "translated",
        targetText: "Clause translated",
      },
      {
        ...signature,
        disposition: "inline",
        status: "translated",
        targetText: "Signature translated",
      },
      {
        ...tableLabel,
        disposition: "inline",
        status: "translated",
        targetText: "Name translated",
      },
    ];
    const plainTranslations = new Map([
      [clause.rowId, "Clause translated"],
      [signature.rowId, "Signature translated"],
      [tableLabel.rowId, "Name translated"],
    ]);
    const legacy = await applyFolioAIEditsToBuffer(
      buffer,
      buildOperations(rows, plainTranslations),
      { author: "test", mode: "direct" },
    );
    const legacyTargetSignature = await paragraphSignature(
      legacy.buffer,
      clause.rowId,
    );
    // Fault-boundary assertion: the old plain replaceBlock path reaches this
    // fixture and loses the tab attached to the italic source run.
    expect(legacyTargetSignature).not.toContain("<w:tab");

    const formatted = await extractFormattedBilingualUnits(buffer, units);
    const richTranslations = new Map(
      formatted.map((unit) => [
        unit.rowId,
        {
          text: unit.spans.map((_, index) => `translated-${index}`).join(""),
          spans: unit.spans.map(({ id }, index) => ({
            id,
            text: `translated-${index}`,
          })),
        },
      ]),
    );
    const formattedBuffer = await applyFormattedBilingualTranslations(
      buffer,
      rows,
      richTranslations,
    );
    const formattedTargetSignature = await paragraphSignature(
      formattedBuffer,
      clause.rowId,
    );
    for (const localName of ["cr", "noBreakHyphen", "softHyphen"]) {
      expect(wordElementCount(formattedTargetSignature, localName)).toBe(1);
    }
    const applied = await applyFolioAIEditsToBuffer(
      formattedBuffer,
      buildFormattingPreservingOperations(
        rows,
        new Set(richTranslations.keys()),
      ),
      { author: "test", mode: "direct" },
    );

    const sourceClauseSignature = await paragraphSignature(
      buffer,
      clause.sourceParaId ?? "",
    );
    const sourceInlineSignature = await paragraphSignature(
      buffer,
      signature.sourceParaId,
    );
    const sourceTableSignature = await paragraphSignature(
      buffer,
      tableLabel.rowId,
    );
    const targetClauseSignature = await paragraphSignature(
      applied.buffer,
      clause.rowId,
    );
    expect(targetClauseSignature).toContain("<w:b");
    expect(targetClauseSignature).toContain("<w:i");
    expect(targetClauseSignature).toContain("<w:u");
    expect(targetClauseSignature).toContain("<w:highlight");
    expect(targetClauseSignature).toContain("<w:tab");
    expect(targetClauseSignature).toContain("<w:br");
    // Folio canonicalizes carriage returns to breaks and hyphen controls to
    // their OOXML text equivalents during the later structural edit pass.
    expect(wordElementCount(targetClauseSignature, "br")).toBe(2);
    expect(targetClauseSignature).toContain("‑­");
    expect(targetClauseSignature).toContain("<w:sym");
    expect(targetClauseSignature).toContain("<w:fldChar");
    expect(wordElementCount(targetClauseSignature, "tab")).toBe(1);
    expect(wordElementCount(targetClauseSignature, "fldChar")).toBe(3);
    expect(sourceClauseSignature).toContain("<w:b");
    const inlineSignature = await paragraphSignature(
      applied.buffer,
      signature.sourceParaId,
    );
    expect(inlineSignature).toContain("<w:b");
    expect(inlineSignature).toContain("<w:i");
    expect(inlineSignature).toContain("<w:u");
    expect(inlineSignature).toContain("<w:highlight");
    expect(inlineSignature).toContain("<w:tab");
    expect(inlineSignature).toContain("<w:br");
    expect(inlineSignature).toContain("<w:sym");
    expect(inlineSignature).toContain("<w:fldChar");
    // One complete source sequence plus one translated clone: the inline
    // merge must retain both halves instead of flattening the source.
    for (const localName of ["b", "i", "u", "highlight"]) {
      expect(
        wordElementCount(inlineSignature, localName),
      ).toBeGreaterThanOrEqual(2);
    }
    for (const localName of ["tab", "sym", "fldChar"]) {
      expect(wordElementCount(inlineSignature, localName)).toBe(
        wordElementCount(sourceInlineSignature, localName) * 2,
      );
    }
    expect(wordElementCount(inlineSignature, "br")).toBe(
      (wordElementCount(sourceInlineSignature, "br") +
        wordElementCount(sourceInlineSignature, "cr")) *
        2,
    );
    expect(inlineSignature.match(/‑­/gu)).toHaveLength(2);
    const tableInlineSignature = await paragraphSignature(
      applied.buffer,
      tableLabel.rowId,
    );
    for (const localName of ["b", "i", "u", "highlight"]) {
      expect(
        wordElementCount(tableInlineSignature, localName),
      ).toBeGreaterThanOrEqual(2);
    }
    for (const localName of ["tab", "sym", "fldChar"]) {
      expect(wordElementCount(tableInlineSignature, localName)).toBe(
        wordElementCount(sourceTableSignature, localName) * 2,
      );
    }
    expect(wordElementCount(tableInlineSignature, "br")).toBe(
      (wordElementCount(sourceTableSignature, "br") +
        wordElementCount(sourceTableSignature, "cr")) *
        2,
    );
    expect(tableInlineSignature.match(/‑­/gu)).toHaveLength(2);
  });

  test("rejects a reordered formatted translation span contract", async () => {
    const doc = createEmptyDocument({
      preset: createStellaStyleDocumentPreset(),
    });
    doc.package.document.content = [mixedFormattingParagraph("Clause")];
    const { buffer } = await createBilingualDocx(await createDocx(doc), {
      targetStyleSuffix: "en",
    });
    const { units } = flattenBilingualRows(await readBilingualDocx(buffer));
    const unit = units.at(0);
    if (!unit) {
      throw new Error("fixture has no bilingual row");
    }
    const formatted = (await extractFormattedBilingualUnits(buffer, units)).at(
      0,
    );
    if (!formatted) {
      throw new Error("fixture has no formatted row");
    }
    expect(formatted.spans.length).toBeGreaterThan(1);
    const row: StoredRow = {
      ...unit,
      disposition: "translate",
      status: "translated",
      targetText: "translated",
    };
    const reversedSpans = formatted.spans.toReversed();
    const rejection = await applyFormattedBilingualTranslations(
      buffer,
      [row],
      new Map([
        [
          row.rowId,
          {
            text: reversedSpans.map((span) => span.text).join(""),
            spans: reversedSpans,
          },
        ],
      ]),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(BilingualFormattingError);
    expect(rejection).toHaveProperty("reason", "invalid-spans");
  });

  test("does not project paragraph tab stops as inline controls", async () => {
    const doc = createEmptyDocument({
      preset: createStellaStyleDocumentPreset(),
    });
    doc.package.document.content = [mixedFormattingParagraph("Clause")];
    const bilingual = await createBilingualDocx(await createDocx(doc), {
      targetStyleSuffix: "en",
    });
    const { units } = flattenBilingualRows(
      await readBilingualDocx(bilingual.buffer),
    );
    const unit = units.at(0);
    if (!unit) {
      throw new Error("fixture has no bilingual row");
    }
    const buffer = await addParagraphPropertyTabStop(
      bilingual.buffer,
      unit.rowId,
    );
    const formatted = (await extractFormattedBilingualUnits(buffer, units)).at(
      0,
    );
    if (!formatted) {
      throw new Error("fixture has no formatted row");
    }
    expect(
      formatted.inline.filter(
        (token) => token.type === "control" && token.kind === "tab",
      ),
    ).toHaveLength(1);
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
