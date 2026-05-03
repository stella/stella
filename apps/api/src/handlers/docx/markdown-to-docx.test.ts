import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { markdownToDocx } from "./markdown-to-docx";
import { DEFAULT_STYLE_MAPPING } from "./style-guide";

const TEMPLATE_PATH = new URL("fixtures/test-template.docx", import.meta.url)
  .pathname;

const SAMPLE_MARKDOWN = `# Non-Disclosure Agreement

## Definitions

In this Agreement, the following terms shall have the meanings set out below:

### Confidential Information

#### Scope

Confidential Information means any information disclosed by one party to the other, whether orally, in writing, or by inspection of tangible objects, including:

- trade secrets and proprietary information;
- financial data and business plans;
- customer lists and supplier agreements;
- technical data and know-how.

> For the avoidance of doubt, Confidential Information shall not include information that is or becomes publicly available through no fault of the receiving party.

### Obligations of the Receiving Party

The Receiving Party agrees to:

- hold the Confidential Information in strict confidence;
- not disclose it to any third party without prior written consent;
- use it solely for the purposes of evaluating the proposed transaction.

## Term and Termination

This Agreement shall remain in effect for a period of **two (2) years** from the date of execution.

## Governing Law

This Agreement shall be governed by and construed in accordance with the laws of the *Czech Republic*.

| Party | Role | Jurisdiction |
| --- | --- | --- |
| Alpha Corp | Disclosing Party | Czech Republic |
| Beta Ltd | Receiving Party | United Kingdom |
`;

describe("markdownToDocx", () => {
  test("produces a valid DOCX buffer", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
  });

  test("document.xml references TitleNoSubheading", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toBeDefined();
    expect(docXml).toContain("TitleNoSubheading");
  });

  test("document.xml references cascade styles", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toBeDefined();
    expect(docXml).toContain("A1stLevelNumbering");
    expect(docXml).toContain("A2ndLevelNumbering");
    expect(docXml).toContain("A3rdLevelNumbering");
  });

  test("fallback styles define every default style mapping target", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);

    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    expect(stylesXml).toBeDefined();

    for (const styleId of new Set(Object.values(DEFAULT_STYLE_MAPPING))) {
      expect(stylesXml).toContain(`w:styleId="${styleId}"`);
    }
  });

  test("bullets use text prefix, not numbering", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN);
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toBeDefined();
    // Bullet character should be present as text
    expect(docXml).toContain("\u2022");
  });

  test("handles empty markdown", async () => {
    const buffer = await markdownToDocx("");

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  test("handles markdown with only a title", async () => {
    const buffer = await markdownToDocx("# Just a Title");
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("TitleNoSubheading");
    expect(docXml).toContain("Just a Title");
  });

  test("preserves soft line breaks inside markdown paragraphs", async () => {
    const buffer = await markdownToDocx("Seller\nrepresented by Jane Doe");
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toBeDefined();
    expect(docXml).toContain("<w:br");
  });

  test("with template: injects all custom styles", async () => {
    const buffer = await markdownToDocx(SAMPLE_MARKDOWN, {
      templatePath: TEMPLATE_PATH,
    });
    const zip = await JSZip.loadAsync(buffer);

    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    expect(stylesXml).toBeDefined();
    // Template's custom styles should be present
    expect(stylesXml).toContain("TitleNoSubheading");
    expect(stylesXml).toContain("A1stLevelNumbering");
    expect(stylesXml).toContain("AgreedTerms");
  });

  test("with template: rewrites language", async () => {
    const buffer = await markdownToDocx("# Test", {
      templatePath: TEMPLATE_PATH,
      lang: "de-DE",
    });
    const zip = await JSZip.loadAsync(buffer);

    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    expect(stylesXml).toBeDefined();
    expect(stylesXml).toContain('w:val="de-DE"');
    // Original Czech should be replaced
    expect(stylesXml).not.toContain('w:val="cs-CZ"');
  });
});
