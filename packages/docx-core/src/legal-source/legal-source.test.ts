import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  compileLegalSourceToDocx,
  compileLegalSourceToDocument,
  parseLegalSource,
} from "./index";

const SAMPLE_SOURCE = `@doc kind=agreement locale=en-GB numbering=legal page=A4
@title Mutual Non-Disclosure Agreement

@preamble
This Agreement is made between Alpha Ltd and Beta s.r.o.

@recital
The parties wish to exchange confidential information for the Purpose.

@clause 1. Definitions
"Confidential Information" means all non-public information disclosed by either party.

@subclause Permitted Disclosure
A party may disclose Confidential Information to its professional advisers.

@table
| Item | Responsible Party | Status |
| --- | --- | --- |
| Board approval | Alpha Ltd | Open |
| Financing consent | Beta s.r.o. |

@signatures
Alpha Ltd
Beta s.r.o.
`;

describe("Stella Legal Source", () => {
  test("parses compact legal directives and applies deterministic autofixes", () => {
    const result = parseLegalSource(SAMPLE_SOURCE);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(result.draft.meta.title).toBe("Mutual Non-Disclosure Agreement");
    expect(result.fixes.map((fix) => fix.code)).toContain(
      "manual-numbering-stripped",
    );
    expect(result.fixes.map((fix) => fix.code)).toContain(
      "table-row-width-normalized",
    );

    const definitions = result.draft.blocks.find(
      (block) => block.type === "clause" && block.heading === "Definitions",
    );
    expect(definitions).toBeDefined();
  });

  test("parses quoted doc attributes and reports invalid known values", () => {
    const result = parseLegalSource(
      [
        '@doc kind=contract numbering=bogus page=Legal orientation=sideways title="Share Purchase Agreement"',
        "@paragraph",
        "Body text.",
      ].join("\n"),
    );

    expect(result.draft.meta.title).toBe("Share Purchase Agreement");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-doc-attribute",
          message: 'Invalid @doc kind "contract".',
        }),
        expect.objectContaining({
          code: "invalid-doc-attribute",
          message: 'Invalid @doc numbering "bogus".',
        }),
        expect.objectContaining({
          code: "invalid-doc-attribute",
          message: 'Invalid @doc page "Legal".',
        }),
        expect.objectContaining({
          code: "invalid-doc-attribute",
          message: 'Invalid @doc orientation "sideways".',
        }),
      ]),
    );
  });

  test("parses structured signature party fields", () => {
    const result = parseLegalSource(
      [
        '@doc title="Execution Version"',
        "@signatures",
        "Party: Alpha Ltd",
        "By: Jane Doe",
        "Title: Chief Executive Officer",
        "Beta s.r.o.",
        "Name: Jan Novak",
        "Title: Jednatel",
      ].join("\n"),
    );

    const signatures = result.draft.blocks.find(
      (block) => block.type === "signatures",
    );

    expect(signatures).toEqual({
      type: "signatures",
      parties: [
        {
          name: "Alpha Ltd",
          signatory: "Jane Doe",
          title: "Chief Executive Officer",
        },
        { name: "Beta s.r.o.", signatory: "Jan Novak", title: "Jednatel" },
      ],
    });
  });

  test("strips manual ordered-list markers before applying DOCX numbering", () => {
    const result = parseLegalSource(
      [
        '@doc title="Numbered List"',
        "@list ordered",
        "1. First item",
        "2) Second item",
        "3.1 Third item",
      ].join("\n"),
    );

    const list = result.draft.blocks.find((block) => block.type === "list");

    expect(list).toEqual({
      type: "list",
      ordered: true,
      items: ["First item", "Second item", "Third item"],
    });
  });

  test("does not strip legitimate one-letter clause heading words", () => {
    const result = parseLegalSource(
      [
        '@doc title="Agreement"',
        "@clause A Party's Obligations",
        "Each party must comply.",
        "@clause A. Definitions",
        "Defined terms apply.",
      ].join("\n"),
    );

    const clauses = result.draft.blocks.filter(
      (block) => block.type === "clause",
    );

    expect(clauses.map((clause) => clause.heading)).toEqual([
      "A Party's Obligations",
      "Definitions",
    ]);
  });

  test("compiles to the canonical document model with legal numbering", () => {
    const result = compileLegalSourceToDocument(SAMPLE_SOURCE);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    const paragraphs = result.document.package.document.content.filter(
      (block) => block.type === "paragraph",
    );
    const numbered = paragraphs.filter(
      (paragraph) => paragraph.formatting?.numPr !== undefined,
    );

    expect(numbered.length).toBeGreaterThanOrEqual(2);
    expect(
      result.document.package.numbering?.abstractNums.at(0)?.levels,
    ).toHaveLength(5);
  });

  test("compiles numbering=none without numbering definitions or paragraph numPr", async () => {
    const source = [
      '@doc numbering=none title="Unnumbered Memo"',
      "@clause Background",
      "The parties agree the document should remain unnumbered.",
      "@list",
      "- First item",
      "- Second item",
    ].join("\n");
    const result = compileLegalSourceToDocument(source);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    expect(result.document.package.numbering).toBeUndefined();
    const paragraphs = result.document.package.document.content.filter(
      (block) => block.type === "paragraph",
    );
    expect(
      paragraphs.every(
        (paragraph) => paragraph.formatting?.numPr === undefined,
      ),
    ).toBe(true);

    const docxResult = await compileLegalSourceToDocx(source);
    expect(docxResult.status).toBe("ok");
    if (docxResult.status !== "ok") {
      return;
    }

    const zip = await JSZip.loadAsync(docxResult.buffer);
    expect(zip.file("word/numbering.xml")).toBeNull();
    const contentTypesXml = await zip
      .file("[Content_Types].xml")
      ?.async("string");
    const documentRelsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(contentTypesXml).not.toContain("numbering.xml");
    expect(documentRelsXml).not.toContain("numbering.xml");
    expect(documentXml).not.toContain("<w:numPr>");
  });

  test("compiles checklist numbering as checkbox list items without legal clause numbering", () => {
    const source = [
      '@doc numbering=checklist title="Closing Checklist"',
      "@clause Before Completion",
      "Confirm each condition.",
      "@list",
      "- Board approval received",
      "- Funds flow approved",
    ].join("\n");
    const result = compileLegalSourceToDocument(source);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    const paragraphs = result.document.package.document.content.filter(
      (block) => block.type === "paragraph",
    );
    const clause = paragraphs.find(
      (paragraph) => paragraph.formatting?.styleId === "ClauseHeading1",
    );
    const listItems = paragraphs.filter(
      (paragraph) => paragraph.formatting?.styleId === "ListParagraph",
    );

    expect(clause?.formatting?.numPr).toBeUndefined();
    expect(listItems.map((paragraph) => paragraph.formatting?.numPr)).toEqual([
      { numId: 3, ilvl: 0 },
      { numId: 3, ilvl: 0 },
    ]);
    expect(result.document.package.numbering?.abstractNums).toEqual([
      expect.objectContaining({
        abstractNumId: 3,
        levels: [expect.objectContaining({ lvlText: "☐" })],
      }),
    ]);
  });

  test("serializes a valid DOCX package without the docx npm model", async () => {
    const result = await compileLegalSourceToDocx(SAMPLE_SOURCE);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    expect(result.buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("word/styles.xml")).toBeTruthy();
    expect(zip.file("word/numbering.xml")).toBeTruthy();

    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(documentXml).toContain(
      "Mutual Non-Disclosure Agreement".toUpperCase(),
    );
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<w:tblGrid>");

    const numberingXml = await zip.file("word/numbering.xml")?.async("string");
    expect(numberingXml).toContain("<w:nsid");
    expect(numberingXml).toContain("<w:lvlJc");
  });
});
