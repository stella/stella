import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { resolveAmbiguitiesByRule } from "@/api/lib/templates/house-style/ambiguity";
import { folioTemplatePlanEngine } from "@/api/lib/templates/house-style/folio-engine";
import { formatOntoTemplate } from "@/api/lib/templates/house-style/format-onto-template";

// Invented documents, built part by part.
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const PACKAGE = "http://schemas.openxmlformats.org/package/2006";
const OFFICE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml";

type Parts = { body: string; styles: string; numbering: string };

const docx = async ({ body, styles, numbering }: Parts) => {
  const zip = new ZipArchive();
  const parts = {
    "[Content_Types].xml": `${XML}<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORD}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${WORD}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${WORD}.numbering+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${OFFICE}/numbering" Target="numbering.xml"/></Relationships>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `${XML}<w:styles ${W}>${styles}</w:styles>`,
    "word/numbering.xml": `${XML}<w:numbering ${W}>${numbering}</w:numbering>`,
  };
  for (const [path, content] of Object.entries(parts)) {
    zip.set(path, content);
  }
  return await zip.generate();
};

const paragraph = (text: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const styled = (styleId: string): string => `<w:pStyle w:val="${styleId}"/>`;
const listed = (numId: number, ilvl: number): string =>
  `<w:numPr><w:ilvl w:val="${String(ilvl)}"/><w:numId w:val="${String(numId)}"/></w:numPr>`;
const style = (styleId: string, name: string, properties = ""): string =>
  `<w:style w:type="paragraph" w:styleId="${styleId}"><w:name w:val="${name}"/>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}</w:style>`;
const level = (
  ilvl: number,
  numFmt: string,
  lvlText: string,
  pStyle = "",
): string =>
  `<w:lvl w:ilvl="${String(ilvl)}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>${pStyle === "" ? "" : `<w:pStyle w:val="${pStyle}"/>`}<w:lvlText w:val="${lvlText}"/></w:lvl>`;
const list = (id: number, levels: string): string =>
  `<w:abstractNum w:abstractNumId="${String(id)}"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>`;
const instance = (numId: number, abstractNumId: number): string =>
  `<w:num w:numId="${String(numId)}"><w:abstractNumId w:val="${String(abstractNumId)}"/></w:num>`;

const template = async () =>
  await docx({
    body: [
      paragraph("AGREEMENT", styled("Title")),
      paragraph("Heading", styled("Article")),
      paragraph("Clause text.", styled("Clause1")),
    ].join(""),
    styles: [
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      style("Title", "Title"),
      style("Body", "Body Text"),
      style("Article", "Article heading", listed(1, 0)),
      style("Clause1", "Clause 1.1", listed(1, 1)),
    ].join(""),
    numbering:
      list(
        0,
        level(0, "decimal", "Article %1", "Article") +
          level(1, "decimal", "%1.%2.", "Clause1") +
          level(2, "lowerLetter", "(%3)") +
          level(3, "lowerRoman", "(%4)"),
      ) + instance(1, 0),
  });

const source = async () =>
  await docx({
    body: [
      paragraph("SERVICES AGREEMENT"),
      paragraph("Article 1"),
      paragraph("Scope"),
      paragraph("The supplier provides the services.", listed(1, 0)),
      paragraph("The customer pays the fee.", listed(1, 0)),
      // A label no reader here restates as a level text.
      paragraph("A point with a composite number.", listed(2, 1)),
      paragraph("A closing sentence."),
    ].join(""),
    styles:
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    numbering:
      list(0, level(0, "decimal", "1.%1.")) +
      list(1, level(0, "upperRoman", "%1.") + level(1, "decimal", "%1. %2)")) +
      instance(1, 0) +
      instance(2, 1),
  });

describe("folioTemplatePlanEngine", () => {
  test("reads a document and a template in the contract's flat shape", async () => {
    const manifest = (
      await folioTemplatePlanEngine.analyze(await source())
    ).unwrap();
    expect(manifest.blocks.map(({ label }) => label)).toEqual([
      null,
      null,
      null,
      "1.1.",
      "1.2.",
      "I. 1)",
      null,
    ]);
    const inspection = (
      await folioTemplatePlanEngine.inspect(await template())
    ).unwrap();
    expect(
      inspection.numbering.abstractNums
        .at(0)
        ?.levels.map(({ lvlText }) => lvlText),
    ).toEqual(["Article %1", "%1.%2.", "(%3)", "(%4)"]);
    expect(
      inspection.styles.find(({ styleId }) => styleId === "Clause1")?.numPr,
    ).toEqual({ numId: 1, ilvl: 1 });
  });

  test("formats a document onto a template and keeps every label", async () => {
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: await source(),
        template: await template(),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    const shown = output.blocks.map(({ label, text }) =>
      label === null ? text : `${label} ${text}`,
    );
    // Clauses keep their numbers on the template's list.
    expect(shown).toContain("1.1. The supplier provides the services.");
    expect(shown).toContain("1.2. The customer pays the fee.");
    // The composite number no list prints is text in front of its paragraph.
    expect(shown).toContain("I. 1)\tA point with a composite number.");
    expect(formatted.note.items).toContainEqual(
      expect.objectContaining({ kind: "labelConvertedToText" }),
    );
    expect(formatted.note.counts.labelsConvertedToText).toBe(1);
  });

  test("names the refusal of a document with tracked changes", async () => {
    const tracked = await docx({
      body: `<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Inserted.</w:t></w:r></w:ins></w:p>`,
      styles: "",
      numbering: "",
    });
    const result = await formatOntoTemplate({
      engine: folioTemplatePlanEngine,
      source: tracked,
      template: await template(),
      mode: "keepSource",
      resolveAmbiguities: resolveAmbiguitiesByRule,
    });
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateEngineError",
      reason: "tracked-changes",
    });
  });
});
