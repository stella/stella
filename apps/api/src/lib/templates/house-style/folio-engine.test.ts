import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { resolveAmbiguitiesByRule } from "@/api/lib/templates/house-style/ambiguity";
import { folioTemplatePlanEngine } from "@/api/lib/templates/house-style/folio-engine";
import { formatOntoTemplate } from "@/api/lib/templates/house-style/format-onto-template";
import { HOUSE_STYLE_ROLES } from "@/api/lib/templates/house-style/role-proposer";
import { reformatDocxOntoTemplate } from "@/api/lib/templates/reformat-into-template";
import { REFORMAT_PARAGRAPH_ROLES } from "@/api/lib/templates/reformat-into-template-contract";

// Invented documents, built part by part.
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const PACKAGE = "http://schemas.openxmlformats.org/package/2006";
const OFFICE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml";

const UPRIGHT = '<w:pgSz w:w="11906" w:h="16838"/>';
const TURNED = '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>';

type Parts = {
  body: string;
  styles: string;
  numbering: string;
  /** The page of the body's last section; upright without one. */
  page?: string;
  /** The content of a settings part; the package has none without it. */
  settings?: string;
};

const SETTINGS_TYPE = `<Override PartName="/word/settings.xml" ContentType="${WORD}.settings+xml"/>`;
const SETTINGS_RELATIONSHIP = `<Relationship Id="rId3" Type="${OFFICE}/settings" Target="settings.xml"/>`;

const docx = async ({
  body,
  styles,
  numbering,
  page = UPRIGHT,
  settings,
}: Parts) => {
  const zip = new ZipArchive();
  const withSettings = settings !== undefined;
  const parts: Record<string, string> = {
    "[Content_Types].xml": `${XML}<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORD}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${WORD}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${WORD}.numbering+xml"/>${withSettings ? SETTINGS_TYPE : ""}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${OFFICE}/numbering" Target="numbering.xml"/>${withSettings ? SETTINGS_RELATIONSHIP : ""}</Relationships>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body}<w:sectPr>${page}</w:sectPr></w:body></w:document>`,
    "word/styles.xml": `${XML}<w:styles ${W}>${styles}</w:styles>`,
    "word/numbering.xml": `${XML}<w:numbering ${W}>${numbering}</w:numbering>`,
  };
  if (withSettings) {
    parts["word/settings.xml"] =
      `${XML}<w:settings ${W}>${settings}</w:settings>`;
  }
  for (const [path, content] of Object.entries(parts)) {
    zip.set(path, content);
  }
  return await zip.generate();
};

const paragraph = (text: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
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

const template = async (settings?: string) =>
  await docx({
    ...(settings === undefined ? {} : { settings }),
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
    // The composite number no level of the template prints stays on a copy
    // of the source's own list, which prints it.
    expect(shown).toContain("I. 1) A point with a composite number.");
    expect(formatted.note.counts.labelsConvertedToText).toBe(0);
  });

  test("reads where a document starts a page, how a paragraph is aligned and what its sections are", async () => {
    const manifest = (
      await folioTemplatePlanEngine.analyze(
        await docx({
          body: [
            paragraph("Cover"),
            PAGE_BREAK,
            paragraph("A centred line.", '<w:jc w:val="center"/>'),
            paragraph("A page of its own.", "<w:pageBreakBefore/>"),
            paragraph(
              "The last line of the upright part.",
              `<w:sectPr>${UPRIGHT}</w:sectPr>`,
            ),
            paragraph("A wide list."),
          ].join(""),
          styles: "",
          numbering: "",
          page: TURNED,
        }),
      )
    ).unwrap();
    expect(manifest.blocks.at(1)).toMatchObject({ text: "", pageBreaks: 1 });
    expect(manifest.blocks.at(2)?.alignment).toBe("center");
    expect(manifest.blocks.at(3)?.pageBreakBefore).toBe(true);
    expect(manifest.blocks.at(4)?.endsSection).toBe(true);
    expect(manifest.sections?.map(({ orientation }) => orientation)).toEqual([
      "portrait",
      "landscape",
    ]);
  });

  test("a formatted document starts its pages where the source does and keeps a turned page", async () => {
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: await docx({
          body: [
            paragraph("SERVICES AGREEMENT"),
            paragraph("Article 1"),
            paragraph("Scope"),
            paragraph("The supplier provides the services.", listed(1, 0)),
            PAGE_BREAK,
            paragraph("Article 2"),
            paragraph("Fees"),
            paragraph(
              "The customer pays the fee.",
              `${listed(1, 0)}<w:sectPr>${UPRIGHT}</w:sectPr>`,
            ),
            paragraph("A wide list of the fees."),
          ].join(""),
          styles:
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
          numbering: list(0, level(0, "decimal", "%1.")) + instance(1, 0),
          page: TURNED,
        }),
        template: await template(),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    // The blank paragraph that held the break is left out; the heading
    // after it starts the page.
    expect(formatted.note.counts.pageStarts).toBe(1);
    expect(
      output.blocks.find(({ text }) => text === "Fees")?.pageBreakBefore,
    ).toBe(true);
    // The part on a turned page stays on one.
    expect(formatted.note.counts.sectionsKept).toBe(2);
    expect(output.sections?.map(({ orientation }) => orientation)).toEqual([
      "portrait",
      "landscape",
    ]);
  });

  test("reads the highlight colours a document uses, whichever quote its XML writes", async () => {
    const highlighted = await docx({
      body: `<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>One</w:t></w:r><w:r><w:rPr><w:highlight w:val='cyan'/></w:rPr><w:t>Two</w:t></w:r><w:r><w:rPr><w:highlight w:val="none"/></w:rPr><w:t>Three</w:t></w:r></w:p>`,
      styles: "",
      numbering: "",
    });
    expect(
      (await folioTemplatePlanEngine.highlightColors(highlighted))
        .unwrap()
        .toSorted(),
    ).toEqual(["cyan", "yellow"]);
  });

  test("names the refusal of a file that is no document", async () => {
    const result = await formatOntoTemplate({
      engine: folioTemplatePlanEngine,
      source: new TextEncoder().encode("not a package"),
      template: await template(),
      mode: "keepSource",
      resolveAmbiguities: resolveAmbiguitiesByRule,
    });
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateEngineError",
      reason: "archive-unreadable",
    });
  });

  test("a memo's own lines fill the header of fields the template keeps", async () => {
    const cell = (text: string): string =>
      `<w:tc><w:p>${text === "" ? "" : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`}</w:p></w:tc>`;
    const row = (name: string): string =>
      `<w:tr>${cell(name)}${cell("")}</w:tr>`;
    const memoTemplate = await docx({
      body: [
        paragraph("MEMORANDUM", styled("Title")),
        `<w:tbl>${["From:", "To:", "Date:", "Subject:"].map(row).join("")}</w:tbl>`,
        paragraph("Text of the memo goes here.", styled("Body")),
      ].join(""),
      styles: [
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
        style("Title", "Title"),
        style("Body", "Body Text"),
      ].join(""),
      numbering: "",
    });
    const memo = await docx({
      body: [
        paragraph("MEMORANDUM"),
        paragraph("To: Jane Roe"),
        paragraph("From: Peter Lang"),
        paragraph("Re: Lease of the warehouse"),
        paragraph("The lease ends in June."),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: "",
    });
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: memo,
        template: memoTemplate,
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    expect(formatted.note.items).toContainEqual(
      expect.objectContaining({ kind: "headerFieldsFilled" }),
    );
    const texts = (await folioTemplatePlanEngine.analyze(formatted.docx))
      .unwrap()
      .blocks.map(({ text }) => text);
    // The values stand in the cells, word for word, without their own
    // names; the cell without a line stays empty.
    expect(texts).toContain("Jane Roe");
    expect(texts).toContain("Peter Lang");
    expect(texts).toContain("Lease of the warehouse");
    expect(texts).not.toContain("To: Jane Roe");
    expect(texts).toContain("The lease ends in June.");
  });

  test("a cell paragraph the source sets tight stays tight in the output", async () => {
    const TIGHT = '<w:spacing w:before="0" w:after="0"/>';
    const cell = (text: string, properties = ""): string =>
      `<w:tc>${paragraph(text, properties)}</w:tc>`;
    const tabled = await docx({
      body: [
        paragraph("SERVICES AGREEMENT"),
        paragraph("Article 1"),
        paragraph("Scope"),
        paragraph("The supplier provides the services.", listed(1, 0)),
        `<w:tbl><w:tr>${cell("Item", TIGHT)}${cell("Price")}</w:tr></w:tbl>`,
        paragraph("A closing sentence."),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
    });
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: tabled,
        template: await template(),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    // Both cells keep what the source gives them: no space around the
    // first by hand, none around the second by the defaults, and single
    // lines, where the template's text style would space them out.
    expect(formatted.note.items).toContainEqual({
      kind: "cellSpacingKept",
      blocks: 2,
    });
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    const inEffect = (text: string) =>
      output.blocks.find((block) => block.text === text)?.spacingInEffect;
    expect(inEffect("Item")).toEqual({
      before: 0,
      after: 0,
      line: 240,
      lineRule: "auto",
    });
    expect(inEffect("Price")).toEqual(inEffect("Item"));
  });

  test("a field of the source to a heading whose number a field counts stays a field", async () => {
    const run = (inner: string, bold = false): string =>
      `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}${inner}</w:r>`;
    const char = (type: string, bold = false): string =>
      run(`<w:fldChar w:fldCharType="${type}"/>`, bold);
    const code = (text: string, bold = false): string =>
      run(`<w:instrText xml:space="preserve">${text}</w:instrText>`, bold);
    const said = (value: string, bold = false): string =>
      run(`<w:t xml:space="preserve">${value}</w:t>`, bold);
    const counted = `${char("begin")}${code(String.raw` AUTONUMLGL  \* Arabic \e `)}${char("end")}`;
    const cited = [
      char("begin", true),
      code(String.raw` REF annex1 \h  \* MERGEFORMAT `, true),
      char("separate", true),
      said("Annex 1 - Prices", true),
      char("end", true),
    ].join("");
    const fielded = await docx({
      body: [
        paragraph("SERVICES AGREEMENT"),
        paragraph("Article 1"),
        paragraph("Scope"),
        `<w:p><w:pPr>${listed(1, 0)}</w:pPr>${said("The prices are listed in ")}${cited}${said(".")}</w:p>`,
        paragraph("A closing sentence."),
        `<w:p><w:bookmarkStart w:id="1" w:name="annex1"/>${said("Annex ")}${counted}${said(" - Prices")}<w:bookmarkEnd w:id="1"/></w:p>`,
        paragraph("The price list."),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
    });
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: fielded,
        // A plan with fields asks the reader to update them on open.
        template: await template('<w:defaultTabStop w:val="708"/>'),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    expect(formatted.outcome.repairs).toEqual([]);
    expect(formatted.plan.references).toContainEqual(
      expect.objectContaining({
        instruction: String.raw`\h \* MERGEFORMAT`,
        expectedText: "Annex 1 - Prices",
      }),
    );
    // The output's field names the bookmark the engine set around the
    // heading, which still counts its own number.
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    const citing = output.blocks.find(({ text }) =>
      text.startsWith("The prices"),
    );
    const heading = output.blocks.find(({ text }) => text.startsWith("Annex"));
    expect(heading?.selfNumbers).toEqual([6]);
    expect(citing?.crossReferences).toEqual([
      expect.objectContaining({
        targetBlockId: heading?.id,
        targetWhole: true,
      }),
    ]);
    const xml =
      (await (
        await ZipArchive.read(formatted.docx)
      )
        .entry("word/document.xml")
        ?.text()) ?? "";
    expect(xml).toMatch(/ REF _Ref\d+ \\h \\\* MERGEFORMAT /u);
  });

  test("a clause that cites itself through its source's field keeps the link", async () => {
    const said = (value: string): string =>
      `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
    const char = (type: string): string =>
      `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const cited = [
      char("begin"),
      String.raw`<w:r><w:instrText xml:space="preserve"> REF _Ref1 \r \h </w:instrText></w:r>`,
      char("separate"),
      said("1.1"),
      char("end"),
    ].join("");
    const selfCiting = await docx({
      body: [
        paragraph("SERVICES AGREEMENT"),
        paragraph("Article 1"),
        paragraph("Scope"),
        `<w:p><w:pPr>${listed(1, 0)}</w:pPr><w:bookmarkStart w:id="1" w:name="_Ref1"/>${said("The supplier provides the services. Nothing in this Section ")}${cited}${said(" limits them.")}<w:bookmarkEnd w:id="1"/></w:p>`,
        paragraph("A closing sentence."),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
    });
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: selfCiting,
        template: await template('<w:defaultTabStop w:val="708"/>'),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    expect(formatted.outcome.repairs).toEqual([]);
    const own = formatted.plan.references?.find(
      ({ blockId, targetBlockId }) => blockId === targetBlockId,
    );
    expect(own).toMatchObject({ expectedText: "1.1" });
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    const clause = output.blocks.find(({ text }) =>
      text.startsWith("The supplier"),
    );
    // The paragraph's own bookmark holds the field that shows its number.
    expect(clause?.crossReferences).toEqual([
      expect.objectContaining({ targetBlockId: clause?.id }),
    ]);
  });

  test("a dot drawn on the source's page is left out of the paragraph it sits in", async () => {
    const WP =
      "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const WPS =
      "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
    const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    // A floating dot whose place is counted from the page, no text of its
    // own and no picture.
    const dot = `<w:r><mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:wps="${WPS}" Requires="wps"><w:drawing><wp:anchor xmlns:wp="${WP}" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>967105</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>1197610</wp:posOffset></wp:positionV><wp:extent cx="59055" cy="59055"/><wp:wrapNone/><wp:docPr id="1" name="Shape 1"/><a:graphic xmlns:a="${A}"><a:graphicData uri="${WPS}"><wps:wsp><wps:spPr/><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>`;
    const marked = await docx({
      body: [
        paragraph("SERVICES AGREEMENT"),
        paragraph("Article 1"),
        paragraph("Scope"),
        `<w:p><w:pPr>${listed(1, 0)}</w:pPr>${dot}<w:r><w:t xml:space="preserve">The supplier provides the services.</w:t></w:r></w:p>`,
        paragraph("A closing sentence."),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
    });
    const read = (await folioTemplatePlanEngine.analyze(marked)).unwrap();
    const clause = read.blocks.find(({ text }) =>
      text.startsWith("The supplier"),
    );
    expect(clause).toMatchObject({ inlineObjects: 1, pageShapes: 1 });
    if (clause === undefined) {
      throw new Error("the source has no supplier clause");
    }
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: marked,
        template: await template(),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    expect(formatted.note.items).toContainEqual({
      kind: "pageMarksDropped",
      blockId: clause.id,
      marks: 1,
    });
    const output = (
      await folioTemplatePlanEngine.analyze(formatted.docx)
    ).unwrap();
    // The paragraph keeps its text and nothing of the drawing.
    expect(
      output.blocks.find(({ text }) => text.startsWith("The supplier")),
    ).toMatchObject({ inlineObjects: 0 });
  });

  test("formats one view of a document with tracked changes: accepted unless the caller asks for the rejected one", async () => {
    const tracked = await docx({
      body: `<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:r><w:t>.</w:t></w:r></w:p>`,
      styles: "",
      numbering: "",
    });
    const textOf = async (view?: "accept" | "reject") => {
      const formatted = (
        await formatOntoTemplate({
          engine: folioTemplatePlanEngine,
          source: tracked,
          template: await template(),
          mode: "keepSource",
          resolveAmbiguities: resolveAmbiguitiesByRule,
          ...(view === undefined ? {} : { trackedChanges: view }),
        })
      ).unwrap();
      expect(formatted.plan.trackedChanges).toBe(view ?? "accept");
      expect(formatted.note.items.at(0)).toMatchObject({
        kind: "trackedChangesResolved",
        view: view ?? "accept",
        stated: view !== undefined,
      });
      const output = (
        await folioTemplatePlanEngine.analyze(formatted.docx)
      ).unwrap();
      // The output states no change of its own.
      expect(output.trackedChanges).toBe(0);
      return output.blocks
        .map(({ text }) => text)
        .filter((text) => text !== "");
    };
    expect(await textOf()).toContain("Kept inserted.");
    expect(await textOf("reject")).toContain("Kept deleted.");
  });

  test("formats a document with its tracked changes kept: the output is the same redline", async () => {
    const tracked = await docx({
      body: `<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:r><w:t>.</w:t></w:r></w:p>`,
      styles: "",
      numbering: "",
    });
    const formatted = (
      await formatOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: tracked,
        template: await template(),
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
        trackedChanges: "keep",
      })
    ).unwrap();
    expect(formatted.plan.trackedChanges).toBe("keep");
    expect(formatted.note.items.at(0)).toMatchObject({
      kind: "trackedChangesKept",
      insertions: 1,
      deletions: 1,
    });
    // The output tracks what the source tracks, and reads as the source
    // does in either view.
    const kept = (
      await folioTemplatePlanEngine.analyze(formatted.docx, {
        trackedChanges: "keep",
      })
    ).unwrap();
    expect(kept.trackedChangesKept).toMatchObject({
      insertions: 1,
      deletions: 1,
      authors: ["A"],
    });
    const textsOf = async (view: "accept" | "reject") =>
      (
        await folioTemplatePlanEngine.analyze(formatted.docx, {
          trackedChanges: view,
        })
      )
        .unwrap()
        .blocks.map(({ text }) => text);
    expect(await textsOf("accept")).toContain("Kept inserted.");
    expect(await textsOf("reject")).toContain("Kept deleted.");
  });
});

describe("role questions a caller answers", () => {
  const marked = async () =>
    await docx({
      body: [
        paragraph("Confidential draft"),
        paragraph("SERVICES AGREEMENT"),
        paragraph("Article 1"),
        paragraph("Scope"),
        paragraph("The supplier provides the services.", listed(1, 0)),
        paragraph("The customer pays the fee.", listed(1, 0)),
      ].join(""),
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
    });
  const reformat = async (
    options: Partial<Parameters<typeof reformatDocxOntoTemplate>[0]>,
  ) =>
    (
      await reformatDocxOntoTemplate({
        engine: folioTemplatePlanEngine,
        source: await marked(),
        template: await template(),
        numbering: "keep_source",
        acceptSuggestedDecisions: false,
        ...options,
      })
    ).unwrap().note;

  test("the caller's vocabulary is the formatter's roles", () => {
    expect([...REFORMAT_PARAGRAPH_ROLES].toSorted()).toEqual(
      [...HOUSE_STYLE_ROLES].toSorted(),
    );
  });

  test("are returned only when asked for, and an answer settles one", async () => {
    expect(await reformat({})).not.toHaveProperty("roleQuestions");
    const asked = await reformat({ askRoleQuestions: true });
    const question = asked.roleQuestions?.find(
      ({ text }) => text === "Confidential draft",
    );
    expect(question?.options).toEqual(["body", "title"]);
    const answered = await reformat({
      askRoleQuestions: true,
      roleDecisions: [{ blockId: question?.blockId ?? "", role: "title" }],
    });
    expect(
      answered.roleQuestions?.some(({ text }) => text === "Confidential draft"),
    ).toBe(false);
  });
});
