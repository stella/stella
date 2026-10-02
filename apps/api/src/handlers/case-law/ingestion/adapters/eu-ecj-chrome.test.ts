import { Glob } from "bun";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as cheerio from "cheerio";

import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { SHELL_STEM } from "@/api/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/corpus";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";

setDefaultTimeout(30_000);

const PARSER_FIXTURES = new URL(
  "../parsers/__fixtures__/eu-ecj/",
  import.meta.url,
);
const ADAPTER_FIXTURES = new URL("__fixtures__/", import.meta.url);
const fixtures = [
  ...Array.from(
    new Glob("*.html.gz").scanSync(PARSER_FIXTURES.pathname),
    (name) => new URL(name, PARSER_FIXTURES),
  ),
  ...Array.from(
    new Glob("eu-ecj-*.html{,.gz}").scanSync(ADAPTER_FIXTURES.pathname),
    (name) => new URL(name, ADAPTER_FIXTURES),
  ),
];
const shellNames = new Set([
  `${SHELL_STEM}.html.gz`,
  "eu-ecj-61985CJ0214.cs.page.html.gz",
  "eu-ecj-61996TJ0183.lt.page.html.gz",
  "eu-ecj-61992TJ0027.sk.page.html.gz",
]);
const NON_CONTENT =
  'script, style, noscript, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], button';
const compact = (text: string) => text.replaceAll(/\s/gu, "");
const reparse = euEcjAdapter.reparseStoredRaw;
if (reparse === undefined) {
  throw new TypeError("Expected the EU adapter to support stored HTML replay");
}

// Drive the stored-output seam: a parser-only check misses the stripped-text
// fallback the adapter takes when validation detects content loss.
describe("EU stored HTML excludes publisher chrome", () => {
  test("covers decision recordings and each unavailable-language response", () => {
    expect(fixtures.length).toBeGreaterThan(shellNames.size);
    const recorded = new Set(
      fixtures.map((file) => file.pathname.split("/").at(-1)),
    );
    for (const name of shellNames) {
      expect(recorded.has(name)).toBe(true);
    }
  });

  test.each(
    fixtures.map(
      (file) => [file.pathname.split("/").at(-1) ?? "", file] as const,
    ),
  )(
    "stores decision content or rejects a document-free shell: %s",
    async (name, file) => {
      const bytes = await Bun.file(file).bytes();
      const html = new TextDecoder().decode(
        name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
      );
      const outcome = await reparse({
        raw: new TextEncoder().encode(
          encodeSourceRawEnvelope({ document: html }),
        ),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        caseNumber: "C-128/22",
        sourceDocumentId: "62022CJ0128",
        language: "en",
        court: "Court of Justice",
        ecli: "ECLI:EU:C:2023:951",
        decisionDate: "2023-12-05",
        decisionType: "judgment",
        sourceUrl: null,
        documentUrl: null,
        metadata: { celex: "62022CJ0128" },
      });
      const $ = cheerio.load(html);
      if (shellNames.has(name)) {
        // The source actually carries the fault; rejecting an empty fixture
        // would say nothing about scripts, navigation or close-button entities.
        expect($("script").length).toBeGreaterThan(0);
        expect(html).toContain("&times;");
        expect(outcome).toMatchObject({
          type: "rejected",
          rejection: "no-document",
        });
        return;
      }

      expect(outcome.type).toBe("parsed");
      if (outcome.type !== "parsed") {
        throw new TypeError(`Expected decision content in ${name}`);
      }
      const { fulltext, documentAst } = outcome.result;
      expect(fulltext).toBeDefined();
      if (fulltext === undefined) {
        throw new TypeError(`Expected stored text in ${name}`);
      }
      expect(markupResidueIn(fulltext)).toBeUndefined();
      const stored = compact(fulltext);
      for (const element of $(NON_CONTENT).toArray()) {
        const chrome = compact($(element).text());
        // A punctuation-only button can share a glyph with the decision.
        if (chrome.length > 20) {
          expect(stored).not.toContain(chrome);
        }
      }

      // Read the publisher's explicit portal/legacy container independently
      // of the parser's common-ancestor boundary. On standalone manifestations
      // the body itself is the decision. The first and last stored blocks must
      // come from that content, even if an ancestor selection widens later.
      const document = $("#document1, div.texte").first();
      const content = document.length > 0 ? document : $("body");
      content.find(NON_CONTENT).remove();
      const sourceText = compact(content.text());
      const blocks = "blocks" in documentAst ? documentAst.blocks : [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of [blocks.at(0), blocks.at(-1)]) {
        expect(block).toBeDefined();
        if (block === undefined) {
          throw new TypeError(`Expected boundary blocks in ${name}`);
        }
        expect(sourceText).toContain(compact(block.plainText));
      }
    },
  );
});
