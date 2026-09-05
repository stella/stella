import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { BlockContent, ParagraphContent } from "@stll/docx-core/model";

import { createChatExportDocx } from "@/api/handlers/chat/export/create-chat-export-docx";
import {
  styleDocumentCitations,
  styleDocumentCitationsWithCounts,
} from "@/api/handlers/chat/export/style-document-citations";
import { markdownToStellaDocument } from "@/api/lib/docx-authoring/from-markdown";

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

const collectText = (blocks: readonly BlockContent[]): string => {
  const fragments: string[] = [];
  for (const content of collectParagraphContent(blocks)) {
    if (content.type !== "run") {
      continue;
    }
    for (const runContent of content.content) {
      if (runContent.type === "text") {
        fragments.push(runContent.text);
      }
    }
  }
  return fragments.join("");
};

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
  internalReferenceMode: "references",
  unverifiedCitationLabel: "Unverified citation",
} as const;

const trustedSearchSummaryOptions = {
  ...options,
  internalReferenceMode: "verified-citations",
  trustedSearchSummaryCitationSources: [
    { number: 1, source: "[1] Matter" },
    { number: 3, source: "[3] Decision" },
  ],
} as const;

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

  test("email citations unwrap or become unverified footnotes", () => {
    const emailCitation =
      "[message passage](#email:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:body-0001)";
    const withoutCitations = styleDocumentCitations(
      markdownToStellaDocument(emailCitation),
      "none",
      options,
    );
    const withFootnotes = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(emailCitation),
      "footnotes",
      options,
    );

    expect(collectText(withoutCitations.package.document.content)).toBe(
      "message passage",
    );
    expect(
      collectHyperlinkTargets(withoutCitations.package.document.content),
    ).toEqual([]);
    expect(withFootnotes.citationCounts).toEqual({
      unverified: 1,
      verified: 0,
    });
    expect(
      withFootnotes.document.package.footnotes?.map(({ content }) =>
        collectText(content),
      ),
    ).toEqual(["Unverified citation: message passage"]);
  });

  test("malformed email citation hrefs export as plain text", () => {
    const malformed = markdownToStellaDocument("[claim](#email:bogus)");
    const result = styleDocumentCitationsWithCounts(
      malformed,
      "footnotes",
      options,
    );

    expect(collectText(result.document.package.document.content)).toBe("claim");
    expect(
      collectHyperlinkTargets(result.document.package.document.content),
    ).toEqual([]);
    expect(result.document.package.footnotes).toEqual([]);
    expect(result.citationCounts).toEqual({ unverified: 0, verified: 0 });
  });

  test("Office citations become unverified footnotes", () => {
    const officeCitation =
      "[revenue total](#office:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:xlsx-0123456789abcdef)";
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(officeCitation),
      "footnotes",
      options,
    );

    expect(result.citationCounts).toEqual({ unverified: 1, verified: 0 });
    expect(
      result.document.package.footnotes?.map(({ content }) =>
        collectText(content),
      ),
    ).toEqual(["Unverified citation: revenue total"]);
  });

  test("malformed Office citation hrefs export as plain text", () => {
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument("[claim](#office:bogus)"),
      "footnotes",
      options,
    );

    expect(collectText(result.document.package.document.content)).toBe("claim");
    expect(result.document.package.footnotes).toEqual([]);
    expect(result.citationCounts).toEqual({ unverified: 0, verified: 0 });
  });

  test("marked search-summary links become verified citations", () => {
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(
        "[matter](#stella-workspace=w) [document](#stella-entity=e)",
      ),
      "footnotes",
      {
        ...options,
        internalReferenceMode: "verified-citations",
      },
    );
    const styled = result.document;

    expect(result.citationCounts).toEqual({ unverified: 0, verified: 2 });
    expect(collectHyperlinkTargets(styled.package.document.content)).toEqual(
      [],
    );
    expect(
      styled.package.footnotes?.map(({ content }) => collectText(content)),
    ).toEqual(["matter", "document"]);
  });

  test("trusted search-summary claim markers become footnotes at the claims", () => {
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(
        [
          "Claim supported by [1][3].",
          "",
          "### Sources",
          "",
          "- [[1] Matter](#stella-workspace=w): source reason",
          "",
          "- [[3] Decision](#stella-decision=3): source reason",
        ].join("\n"),
      ),
      "footnotes",
      trustedSearchSummaryOptions,
    );

    expect(result.citationCounts).toEqual({ unverified: 0, verified: 2 });
    expect(
      collectFootnoteReferenceIds(result.document.package.document.content),
    ).toEqual([1, 2]);
    expect(
      result.document.package.footnotes?.map(({ content }) =>
        collectText(content),
      ),
    ).toEqual(["[1] Matter", "[3] Decision"]);
    expect(
      collectHyperlinkTargets(result.document.package.document.content),
    ).toEqual(["#stella-workspace=w", "#stella-decision=3"]);
  });

  test("none removes trusted search-summary claim markers", () => {
    const styled = styleDocumentCitations(
      markdownToStellaDocument("Claim supported by [1][3]."),
      "none",
      trustedSearchSummaryOptions,
    );

    expect(collectText(styled.package.document.content)).toBe(
      "Claim supported by .",
    );
  });

  test("untrusted marker maps cannot create verified search-summary footnotes", () => {
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument("Claim supported by [1]."),
      "footnotes",
      {
        ...trustedSearchSummaryOptions,
        internalReferenceMode: "unverified-citations",
      },
    );

    expect(result.citationCounts).toEqual({ unverified: 0, verified: 0 });
    expect(collectText(result.document.package.document.content)).toBe(
      "Claim supported by [1].",
    );
    expect(result.document.package.footnotes).toEqual([]);
  });

  test("legacy search-summary links are explicitly unverified", () => {
    const result = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(
        "[matter](#stella-workspace=w) [document](#stella-entity=e)",
      ),
      "footnotes",
      {
        ...options,
        internalReferenceMode: "unverified-citations",
      },
    );

    expect(result.citationCounts).toEqual({ unverified: 2, verified: 0 });
    expect(
      result.document.package.footnotes?.map(({ content }) =>
        collectText(content),
      ),
    ).toEqual(["Unverified citation: matter", "Unverified citation: document"]);
  });

  test("inline counts distinct unverified citations without changing the document", () => {
    const document = markdownToStellaDocument(
      "[first](https://example.com) [repeat](https://example.com) [folio](#folio:A)",
    );
    const result = styleDocumentCitationsWithCounts(
      document,
      "inline",
      options,
    );

    expect(result.document).toBe(document);
    expect(result.citationCounts).toEqual({ unverified: 2, verified: 0 });
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
      styled.package.footnotes?.map((footnote) =>
        collectText(footnote.content),
      ),
    ).toEqual([
      "Unverified citation: external",
      "Unverified citation: Agreement.docx: folio",
      "Unverified citation: decision",
      "Unverified citation: table citation",
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
    expect(footnotesXml).toContain("Unverified citation: supported claim");
    expect(footnotesXml).not.toContain("https://example.com/source");
  });
});
