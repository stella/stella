import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { BlockContent, ParagraphContent } from "@stll/docx-core/model";

import { createChatExportDocx } from "@/api/handlers/chat/export/create-chat-export-docx";
import { styleDocumentCitations } from "@/api/handlers/chat/export/style-document-citations";
import { markdownToStellaDocument } from "@/api/handlers/chat/tools/markdown-to-stella-docx";

const collectParagraphContent = (
  blocks: readonly BlockContent[],
): ParagraphContent[] => {
  const content: ParagraphContent[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        content.push(...block.content);
        break;
      case "table":
        for (const row of block.rows) {
          for (const cell of row.cells) {
            content.push(...collectParagraphContent(cell.content));
          }
        }
        break;
      case "blockSdt":
        content.push(...collectParagraphContent(block.content));
        break;
    }
  }
  return content;
};

const collectHyperlinkTargets = (blocks: readonly BlockContent[]): string[] =>
  collectParagraphContent(blocks).flatMap((content) =>
    content.type === "hyperlink"
      ? [content.href ?? `#${content.anchor ?? ""}`]
      : [],
  );

const collectFootnoteReferenceIds = (
  blocks: readonly BlockContent[],
): number[] => {
  const ids: number[] = [];
  for (const content of collectParagraphContent(blocks)) {
    if (content.type !== "run") {
      continue;
    }
    for (const runContent of content.content) {
      if (runContent.type === "footnoteRef") {
        ids.push(runContent.id);
      }
    }
  }
  return ids;
};

const markdown = [
  "[external](https://example.com/source) and [repeat](https://example.com/source)",
  "",
  "[folio](#folio:A) [decision](#stella-decision=1)",
  "",
  "[entity](#stella-entity=e) [workspace](#stella-workspace=w) [skill](#stella-skill-ref=s)",
  "",
  "| kind | link |",
  "| --- | --- |",
  "| citation | [table citation](https://example.com/table) |",
  "| reference | [table entity](#stella-entity=table) |",
].join("\n");

const options = {
  folioSourceTitle: "Agreement.docx",
  internalCitationFallback: "Citation",
};

describe("styleDocumentCitations", () => {
  test("inline preserves every hyperlink and returns the same document", () => {
    const document = markdownToStellaDocument(markdown);
    expect(styleDocumentCitations(document, "inline", options)).toBe(document);
  });

  test("none unwraps only citations and preserves application references", () => {
    const styled = styleDocumentCitations(
      markdownToStellaDocument(markdown),
      "none",
      options,
    );

    expect(collectHyperlinkTargets(styled.package.document.content)).toEqual([
      "#stella-entity=e",
      "#stella-workspace=w",
      "#stella-skill-ref=s",
      "#stella-entity=table",
    ]);
    expect(
      collectFootnoteReferenceIds(styled.package.document.content),
    ).toEqual([]);
    expect(styled.package.footnotes).toEqual([]);
  });

  test("footnotes are real, destination-deduplicated, and recursive", () => {
    const styled = styleDocumentCitations(
      markdownToStellaDocument(markdown),
      "footnotes",
      options,
    );

    expect(collectHyperlinkTargets(styled.package.document.content)).toEqual([
      "#stella-entity=e",
      "#stella-workspace=w",
      "#stella-skill-ref=s",
      "#stella-entity=table",
    ]);
    expect(
      collectFootnoteReferenceIds(styled.package.document.content),
    ).toEqual([1, 1, 2, 3, 4]);
    expect(styled.package.footnotes?.map((footnote) => footnote.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      styled.package.footnotes?.map(
        (footnote) =>
          footnote.content.at(0)?.content.at(0)?.content.at(0)?.text,
      ),
    ).toEqual([
      "https://example.com/source",
      "Agreement.docx: folio",
      "decision",
      "https://example.com/table",
    ]);
  });

  test("the transformation reaches a fixed point", () => {
    const once = styleDocumentCitations(
      markdownToStellaDocument(markdown),
      "footnotes",
      options,
    );
    const twice = styleDocumentCitations(once, "footnotes", options);

    expect(twice).toEqual(once);
  });

  test("DOCX serialization writes footnote references and the footnote part", async () => {
    const styled = styleDocumentCitations(
      markdownToStellaDocument(
        "The [supported claim](https://example.com/source).",
      ),
      "footnotes",
      options,
    );
    const zip = await JSZip.loadAsync(await createChatExportDocx(styled));
    const contentTypes = await zip.file("[Content_Types].xml")?.async("text");
    const documentXml = await zip.file("word/document.xml")?.async("text");
    const relationships = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("text");
    const footnotesXml = await zip.file("word/footnotes.xml")?.async("text");

    expect(contentTypes).toContain('PartName="/word/footnotes.xml"');
    expect(relationships).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes"',
    );
    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(footnotesXml).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(footnotesXml).toContain('<w:footnote w:id="1">');
    expect(footnotesXml).toContain("<w:footnoteRef/>");
    expect(footnotesXml).toContain("https://example.com/source");
  });
});
