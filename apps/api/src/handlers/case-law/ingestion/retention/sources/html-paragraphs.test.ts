import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

const paragraph = (id: string, text: string): Block => ({
  id,
  anchorId: id,
  type: "paragraph",
  plainText: text,
  inlines: [{ type: "text", text }],
});

const HEADING =
  "Bundesfinanzgericht entscheidet über die Beschwerde der Gesellschaft gegen den Bescheid des Finanzamtes betreffend Umsatzsteuer für die Jahre zweitausendzwanzig bis zweitausenddreiundzwanzig";
const BODY =
  "Die Beschwerde wird als unbegründet abgewiesen, weil die Voraussetzungen des Vorsteuerabzugs nicht vorliegen.";
const BARE = "Eine Revision an den Verwaltungsgerichtshof ist nicht zulässig";

const DOCUMENT = `<body><h1>${HEADING}</h1><p>${BODY}</p>${BARE}<script>tracker()</script><style>p{}</style></body>`;

describe("htmlParagraphs", () => {
  test("every visible run is a paragraph, headings and bare text included", () => {
    expect(htmlParagraphs(DOCUMENT)).toEqual([HEADING, BODY, BARE]);
  });

  test("a parse that dropped a top-level heading reads as lost text", () => {
    const withoutHeading = [paragraph("p1", BODY), paragraph("p2", BARE)];
    // The oracle's own HTML reading collects only content elements, so the
    // heading and the bare text are invisible to it.
    expect(validateAst(DOCUMENT, withoutHeading).ok).toBe(true);
    expect(
      validateAst(
        { type: "paragraphs", paragraphs: htmlParagraphs(DOCUMENT) },
        withoutHeading,
      ).ok,
    ).toBe(false);
  });

  test("line breaks join words, block boundaries split them", () => {
    expect(
      htmlParagraphs(
        "<div>erste<br>Zeile<span> und</span> mehr<blockquote>Zitat</blockquote>Ende</div>",
      ),
    ).toEqual(["erste Zeile und mehr", "Zitat", "Ende"]);
  });

  test("page furniture and hidden elements are not text", () => {
    expect(
      htmlParagraphs(
        '<html><head><title>Seite</title></head><body><div style="-aw-headerfooter-type:header-primary">Kopfzeile</div><template>Vorlage</template><p>Text</p><img alt="Siegel"></body></html>',
      ),
    ).toEqual(["Text", "Siegel"]);
  });
});
