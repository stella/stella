import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { BlockContent, ParagraphContent } from "@stll/docx-core/model";

import { createChatExportDocx } from "@/api/handlers/chat/export/create-chat-export-docx";
import {
  styleDocumentCitations,
  styleDocumentCitationsWithCounts,
} from "@/api/handlers/chat/export/style-document-citations";
import { formatCourtParagraphMark } from "@/api/lib/case-law/court-paragraph-mark";
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
      case "blockCustomXml":
        content.push(...collectParagraphContent(block.content));
        break;
      // Hold no paragraph content: a bookmark or move range marker is a
      // position and a preserved block is opaque markup.
      case "preservedBlock":
      case "bookmarkStart":
      case "bookmarkEnd":
      case "moveFromRangeStart":
      case "moveFromRangeEnd":
      case "moveToRangeStart":
      case "moveToRangeEnd":
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
  formatParagraphMark: (courtParagraphNumber: number) =>
    formatCourtParagraphMark("en", courtParagraphNumber),
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
  test("inline preserves every hyperlink and the document as it was", () => {
    const document = markdownToStellaDocument(markdown);
    expect(styleDocumentCitations(document, "inline", options)).toEqual(
      document,
    );
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

  test("decision passage citations unwrap or become unverified footnotes", () => {
    const passageCitation =
      "[the appeal is dismissed](#stella-decision-passage=33333333-3333-4333-8333-333333333333:p-12)";
    const withoutCitations = styleDocumentCitations(
      markdownToStellaDocument(passageCitation),
      "none",
      options,
    );
    const withFootnotes = styleDocumentCitationsWithCounts(
      markdownToStellaDocument(passageCitation),
      "footnotes",
      options,
    );

    expect(collectText(withoutCitations.package.document.content)).toBe(
      "the appeal is dismissed",
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
    ).toEqual(["Unverified citation: the appeal is dismissed"]);
  });

  test("a passage citation names the court's paragraph number in every style that keeps citations", () => {
    const decision = "33333333-3333-4333-8333-333333333333";
    const numbered = `[the appeal is dismissed](#stella-decision-passage=${decision}:p-12:8)`;
    const unnumbered = `[the appeal is dismissed](#stella-decision-passage=${decision}:p-12)`;
    const footnotesOf = (passage: string) =>
      styleDocumentCitationsWithCounts(
        markdownToStellaDocument(passage),
        "footnotes",
        options,
      ).document.package.footnotes?.map(({ content }) => collectText(content));
    const inline = (passage: string) =>
      styleDocumentCitations(
        markdownToStellaDocument(passage),
        "inline",
        options,
      ).package.document.content;
    const none = styleDocumentCitations(
      markdownToStellaDocument(numbered),
      "none",
      options,
    ).package.document.content;

    expect(footnotesOf(numbered)).toEqual([
      "Unverified citation: the appeal is dismissed (\u00b6\u00a08)",
    ]);
    expect(footnotesOf(unnumbered)).toEqual([
      "Unverified citation: the appeal is dismissed",
    ]);
    expect(collectHyperlinkTargets(inline(numbered))).toEqual([
      `#stella-decision-passage=${decision}:p-12:8`,
    ]);
    expect(collectText(inline(numbered))).toBe(" (\u00b6\u00a08)");
    expect(collectText(inline(unnumbered))).toBe("");
    // No citations at all: the passage reads as the answer's prose.
    expect(collectText(none)).toBe("the appeal is dismissed");
  });

  test("the paragraph mark follows the export's locale", () => {
    expect(formatCourtParagraphMark("de", 1234)).toBe("\u00b6\u00a01.234");
    expect(formatCourtParagraphMark("cs", 8)).toBe("\u00b6\u00a08");
  });

  test("malformed decision passage hrefs export as plain text", () => {
    // A hallucinated anchor or a non-uuid decision must not survive the export
    // as a dead internal hyperlink, whichever style keeps citations: inline
    // export now walks the document too, so it unwraps them the same way.
    for (const style of ["footnotes", "inline"] as const) {
      for (const href of [
        "#stella-decision-passage=not-a-uuid:p-12",
        // Percent-encoded: outside the anchor grammar the parsers ever mint.
        "#stella-decision-passage=33333333-3333-4333-8333-333333333333:p%2D12",
        "#stella-decision-passage=33333333-3333-4333-8333-333333333333",
        // A court number that is not one positive whole number.
        "#stella-decision-passage=33333333-3333-4333-8333-333333333333:p-12:0",
      ]) {
        const document = markdownToStellaDocument(`[claim](${href})`);
        const result = styleDocumentCitationsWithCounts(
          document,
          style,
          options,
        );

        expect(collectText(result.document.package.document.content)).toBe(
          "claim",
        );
        expect(
          collectHyperlinkTargets(result.document.package.document.content),
        ).toEqual([]);
        expect(result.document.package.footnotes).toEqual(
          style === "inline" ? document.package.footnotes : [],
        );
        expect(result.citationCounts).toEqual({ unverified: 0, verified: 0 });
      }
    }
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

    expect(result.document).toEqual(document);
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

  test.each(["blockSdt", "blockCustomXml"] as const)(
    "citations inside a table cell wrapper %s retain their text",
    (wrapper) => {
      const document = markdownToStellaDocument(
        [
          "| kind | link |",
          "| --- | --- |",
          "| citation | [cell citation](https://example.com/cell) |",
        ].join("\n"),
      );
      const content = document.package.document.content.map(
        (block): BlockContent =>
          block.type === "table"
            ? {
                ...block,
                rows: block.rows.map((row) => ({
                  ...row,
                  cells: row.cells.map((cell) => ({
                    ...cell,
                    content: [
                      {
                        ...(wrapper === "blockSdt"
                          ? {
                              type: wrapper,
                              properties: { sdtType: "richText" as const },
                            }
                          : {
                              type: wrapper,
                              openingXml: "<w:customXml>",
                              closingXml: "</w:customXml>",
                            }),
                        content: cell.content,
                      },
                    ],
                  })),
                })),
              }
            : block,
      );
      const wrapped = {
        ...document,
        package: {
          ...document.package,
          document: { ...document.package.document, content },
        },
      };

      const styled = styleDocumentCitations(wrapped, "none", options);

      expect(collectHyperlinkTargets(styled.package.document.content)).toEqual(
        [],
      );
      expect(collectText(styled.package.document.content)).toContain(
        "cell citation",
      );
    },
  );

  test("move range markers are written back where they were in every style", () => {
    const moveMarkers: BlockContent[] = [
      { type: "moveFromRangeStart", id: 1, name: "move1", author: "Author" },
      { type: "moveFromRangeEnd", id: 1 },
      { type: "moveToRangeStart", id: 2, name: "move1", author: "Author" },
      { type: "moveToRangeEnd", id: 2 },
    ];
    const document = markdownToStellaDocument(
      [
        "[body citation](https://example.com/body)",
        "",
        "| kind | link |",
        "| --- | --- |",
        "| citation | [cell citation](https://example.com/cell) |",
      ].join("\n"),
    );
    const content = [
      ...moveMarkers,
      ...document.package.document.content.map((block): BlockContent =>
        block.type === "table"
          ? {
              ...block,
              rows: block.rows.map((row) => ({
                ...row,
                cells: row.cells.map((cell) => ({
                  ...cell,
                  content: [...moveMarkers, ...cell.content],
                })),
              })),
            }
          : block,
      ),
    ];
    const marked = {
      ...document,
      package: {
        ...document.package,
        document: { ...document.package.document, content },
      },
    };
    // Each marker with its container (the body, or a table cell by row and
    // column) and the number of content blocks before it there, so a marker
    // that crosses a paragraph or a cell boundary changes the record.
    type PlacedMarker = {
      container: string;
      precededBy: number;
      marker: BlockContent;
    };
    const markersOf = (
      blocks: readonly BlockContent[],
      container = "body",
    ): PlacedMarker[] => {
      let precededBy = 0;
      return blocks.flatMap((block) => {
        if (block.type.startsWith("move")) {
          return [{ container, precededBy, marker: block }];
        }
        const table = `${container}/${String(precededBy)}`;
        precededBy += 1;
        if (block.type === "table") {
          return block.rows.flatMap((row, rowIndex) =>
            row.cells.flatMap((cell, cellIndex) =>
              markersOf(
                cell.content,
                `${table}/${String(rowIndex)}/${String(cellIndex)}`,
              ),
            ),
          );
        }
        return [];
      });
    };

    // Every marker comes back in the container it was in, at its place.
    const placed = markersOf(content);
    expect(placed.length).toBeGreaterThan(moveMarkers.length);
    for (const style of ["none", "footnotes"] as const) {
      const styled = styleDocumentCitations(marked, style, options);
      expect(markersOf(styled.package.document.content)).toEqual(placed);
    }
    const counted = styleDocumentCitationsWithCounts(marked, "inline", options);
    expect(counted.document).toEqual(marked);
    expect(counted.citationCounts).toEqual({ unverified: 2, verified: 0 });
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
