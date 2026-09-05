import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { docxToMarkdown, inspectDocxPackage } from "@stll/folio-core/server";

import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";

const markdown = `# Title Heading

Some **bold** paragraph text.

## Section Two

- one
- two

1. first
2. second
`;

const xmlPart = async (bytes: ArrayBuffer, path: string) => {
  const inspection = await inspectDocxPackage(bytes, { xmlParts: [path] });
  return inspection.xmlParts.find((part) => part.path === path)?.text;
};

describe("markdownToStellaDocx", () => {
  test("renders markdown content into a valid, Stella-styled DOCX", async () => {
    const bytes = Result.unwrap(await markdownToStellaDocx(markdown));
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Content survives the round trip.
    const roundTripped = await docxToMarkdown(bytes);
    expect(roundTripped).toContain("# Title Heading");
    expect(roundTripped).toContain("## Section Two");
    expect(roundTripped).toContain("Some **bold** paragraph text.");
    expect(roundTripped).toContain("- one");
    expect(roundTripped).toContain("- two");
    expect(roundTripped).toContain("1. first");
    expect(roundTripped).toContain("2. second");

    // Stella's style set (not the default createEmptyDocument() one) was
    // applied: Stella's A4 page geometry and its "BodyText" style (absent
    // from the plain default style catalog) are both present.
    const documentXml = await xmlPart(bytes, "word/document.xml");
    const pageSizeTag = documentXml?.match(/<w:pgSz\b[^>]*\/>/u)?.[0];
    expect(pageSizeTag).toContain('w:w="11906"');
    expect(pageSizeTag).toContain('w:h="16838"');
    expect(pageSizeTag).toContain('w:orient="portrait"');
    expect(await xmlPart(bytes, "word/styles.xml")).toContain(
      'w:styleId="BodyText"',
    );

    // Stella's own reserved numId 1-5 definitions are untouched (still
    // present): the markdown lists were appended after them, not merged
    // into or overwriting them. Before the numId remap, this same markdown
    // rendered as Stella's clause/definitions numbering ("(a) first") because
    // the markdown list numIds collided with the reserved range; the plain
    // "- one" / "1. first" round-trip checks above are the proof it holds.
    const numberingXml = await xmlPart(bytes, "word/numbering.xml");
    for (const numId of [1, 2, 3, 4, 5]) {
      expect(numberingXml).toContain(`<w:num w:numId="${numId}">`);
    }
    // Two markdown-originated lists (one bullet, one ordered) were appended
    // as fresh `w:num` instances above the reserved range.
    expect(numberingXml).toContain('<w:num w:numId="6">');
    expect(numberingXml).toContain('<w:num w:numId="7">');
    expect(numberingXml).not.toContain('<w:num w:numId="8">');
  });

  test("is a no-op on numbering when the markdown has no lists", async () => {
    const bytes = Result.unwrap(
      await markdownToStellaDocx("# Just a heading\n\nAnd text."),
    );
    // Stella's own abstractNum / num definitions, nothing appended.
    expect(await xmlPart(bytes, "word/numbering.xml")).not.toContain(
      'w:numId="6"',
    );
  });
});
