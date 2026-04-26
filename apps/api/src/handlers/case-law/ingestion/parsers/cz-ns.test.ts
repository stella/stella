import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Block } from "@/api/handlers/case-law/document-ast";
import {
  blocksToPlainText,
  extractNsMetadata,
  extractRawChunks,
  parseNsDecisionHtml,
} from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import type { ParseNsDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";

// ── Helpers ─────────────────────────────────────────────────

const baseInput = (
  printHtml: string,
  overrides?: Partial<ParseNsDecisionInput>,
): ParseNsDecisionInput => ({
  documentId: "ns-doc-123",
  webUrl: "https://rozhodnuti.nsoud.cz/detail/123",
  printUrl: "https://rozhodnuti.nsoud.cz/print/123",
  webHtml: "",
  printHtml,
  ...overrides,
});

const findByRole = (blocks: Block[], role: string) =>
  blocks.find((b) => "role" in b && b.role === role);

const findAllByRole = (blocks: Block[], role: string) =>
  blocks.filter((b) => "role" in b && b.role === role);

// ── Metadata HTML for NS ────────────────────────────────────

const metaTableHtml = `
<table id="box-table-a">
  <tbody>
    <tr>
      <td>Soud:</td>
      <td>Nejvyšší soud</td>
    </tr>
    <tr>
      <td>Datum rozhodnutí:</td>
      <td>03/15/2025</td>
    </tr>
    <tr>
      <td>Spisová značka:</td>
      <td>29 Cdo 1234/2024</td>
    </tr>
    <tr>
      <td>ECLI:</td>
      <td>ECLI:CZ:NS:2025:29.CDO.1234.2024.1</td>
    </tr>
    <tr>
      <td>Typ rozhodnutí:</td>
      <td>USNESENÍ</td>
    </tr>
    <tr>
      <td>Heslo:</td>
      <td>Dovolání<br/>Přípustnost dovolání</td>
    </tr>
    <tr>
      <td>Dotčené předpisy:</td>
      <td>§ 237 o. s. ř.<br/>§ 241a odst. 1 o. s. ř.</td>
    </tr>
    <tr>
      <td>Kategorie rozhodnutí:</td>
      <td>D</td>
    </tr>
    <tr>
      <td>Zveřejněno na webu:</td>
      <td>04/01/2025</td>
    </tr>
  </tbody>
</table>
`;

const minimalPrintHtml = `
<html><body>
${metaTableHtml}
<div align="center">
  <b>29 Cdo 1234/2024</b>
</div>
<div align="center">
  <b>U S N E S E N Í</b>
</div>
<p>Nejvyšší soud rozhodl v senátě složeném z předsedy
JUDr. Petra Šuka a soudců JUDr. Filipa Cilečka a JUDr.
Marka Doležala v právní věci žalobkyně ALBA, a.s.,
se sídlem v Praze 1, Dlouhá 123/45, identifikační
číslo osoby 12345678, zastoupené JUDr. Janou Novákovou,
advokátkou, se sídlem v Praze 2, Vinohradská 56,
proti žalovanému Ing. Janu Dvořákovi, narozenému dne
1. ledna 1980, bytem v Brně, Masarykova 789,
o zaplacení částky 5 000 000 Kč s příslušenstvím,
vedené u Městského soudu v Praze pod sp. zn.
72 Cm 100/2022,
o dovolání žalobkyně proti rozsudku Vrchního soudu
v Praze ze dne 20. června 2024, č. j. 5 Cmo 50/2024-156,</p>
<p align="center"><b>takto:</b></p>
<p>I. Dovolání se <b>odmítá</b>.</p>
<p>II. Žádný z účastníků <b>nemá</b> právo na náhradu
nákladů dovolacího řízení.</p>
<p align="center"><b>Odůvodnění:</b></p>
<p>Dovolání žalobkyně proti rozsudku Vrchního soudu
v Praze ze dne 20. června 2024, č. j. 5 Cmo 50/2024-156,
není přípustné.</p>
<p>Podle ustanovení § 237 o. s. ř. není dovolání přípustné,
jestliže směřuje proti rozhodnutí, proti němuž zákon
tento mimořádný opravný prostředek nepřipouští.</p>
<p>V Praze dne 15. března 2025</p>
<p align="center">JUDr. Petr Šuk</p>
<p align="center">předseda senátu</p>
</body></html>
`;

// ── Tests ───────────────────────────────────────────────────

describe("extractNsMetadata", () => {
  test("extracts all metadata fields", () => {
    const $ = cheerio.load(metaTableHtml);
    const { canonical, source } = extractNsMetadata($);

    expect(canonical.court).toBe("Nejvyšší soud");
    expect(canonical.decisionDate).toBe("2025-03-15");
    expect(canonical.caseNumber).toBe("29 Cdo 1234/2024");
    expect(canonical.ecli).toBe("ECLI:CZ:NS:2025:29.CDO.1234.2024.1");
    expect(canonical.decisionType).toBe("USNESENÍ");
    expect(canonical.keywords).toEqual(["Dovolání", "Přípustnost dovolání"]);
    expect(canonical.statutes).toEqual([
      "§ 237 o. s. ř.",
      "§ 241a odst. 1 o. s. ř.",
    ]);
    expect(source["kategorieRozhodnuti"]).toBe("D");
    expect(source["zverejnenoNaWebu"]).toBe("2025-04-01");
  });

  test("converts Domino date format (MM/DD/YYYY -> YYYY-MM-DD)", () => {
    const html = `
      <table id="box-table-a"><tbody>
        <tr><td>Datum rozhodnutí:</td><td>01/05/2025</td></tr>
      </tbody></table>
    `;
    const $ = cheerio.load(html);
    const { canonical } = extractNsMetadata($);

    expect(canonical.decisionDate).toBe("2025-01-05");
  });

  test("handles missing metadata gracefully", () => {
    const html = `<table id="box-table-a"><tbody></tbody></table>`;
    const $ = cheerio.load(html);
    const { canonical } = extractNsMetadata($);

    expect(canonical.court).toBeNull();
    expect(canonical.caseNumber).toBeNull();
    expect(canonical.ecli).toBeNull();
    expect(canonical.keywords).toEqual([]);
    expect(canonical.statutes).toEqual([]);
  });
});

describe("extractRawChunks", () => {
  test("extracts content after metadata table", () => {
    const $ = cheerio.load(minimalPrintHtml);
    const chunks = extractRawChunks($);

    expect(chunks.length).toBeGreaterThan(0);

    // Should have inlines-type chunks
    const inlineChunks = chunks.filter((c) => c.kind === "inlines");
    expect(inlineChunks.length).toBeGreaterThan(0);
  });

  test("identifies centered content", () => {
    const $ = cheerio.load(minimalPrintHtml);
    const chunks = extractRawChunks($);

    const centeredChunks = chunks.filter(
      (c) => c.kind === "inlines" && c.centered,
    );
    expect(centeredChunks.length).toBeGreaterThan(0);
  });
});

describe("blocksToPlainText", () => {
  test("joins block plainTexts with double newlines", () => {
    const blocks: Block[] = [
      {
        id: "b1",
        anchorId: "p-1",
        type: "paragraph",
        inlines: [{ type: "text", text: "First" }],
        plainText: "First",
      },
      {
        id: "b2",
        anchorId: "p-2",
        type: "paragraph",
        inlines: [{ type: "text", text: "Second" }],
        plainText: "Second",
      },
    ];

    const text = blocksToPlainText(blocks);

    expect(text).toBe("First\n\nSecond");
  });

  test("collapses triple+ newlines", () => {
    const blocks: Block[] = [
      {
        id: "b1",
        anchorId: "p-1",
        type: "paragraph",
        inlines: [{ type: "text", text: "A" }],
        plainText: "A",
      },
      {
        id: "b2",
        anchorId: "p-2",
        type: "paragraph",
        inlines: [{ type: "text", text: "B\n\n\nC" }],
        plainText: "B\n\n\nC",
      },
    ];

    const text = blocksToPlainText(blocks);

    expect(text).not.toContain("\n\n\n");
  });
});

describe("parseNsDecisionHtml", () => {
  describe("full parse", () => {
    test("produces structured AST from print HTML", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst, metadata, fulltext } = parseNsDecisionHtml(input);

      expect(documentAst.version).toBe(1);
      expect(documentAst.source.system).toBe("cz_ns");
      expect(documentAst.blocks.length).toBeGreaterThan(0);

      // Metadata extracted
      expect(metadata.court).toBe("Nejvyšší soud");
      expect(metadata.caseNumber).toBe("29 Cdo 1234/2024");

      // Fulltext not empty
      expect(fulltext.length).toBeGreaterThan(100);
    });
  });

  describe("decision title detection", () => {
    test("detects centered all-caps title", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst } = parseNsDecisionHtml(input);

      const titles = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "decision-title",
      );
      expect(titles.length).toBeGreaterThan(0);
    });
  });

  describe("section headings", () => {
    test("detects Odůvodnění as section heading", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst } = parseNsDecisionHtml(input);

      const headings = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "section-heading",
      );
      const oduv = headings.find((h) => h.plainText.includes("Odůvodnění"));
      expect(oduv).toBeDefined();
    });

    test("detects spaced O d ů v o d n ě n í", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>Nejvyšší soud</td></tr>
        </tbody></table>
        <div align="center"><b>U S N E S E N Í</b></div>
        <p>Soud rozhodl takto:</p>
        <p>I. Dovolání se odmítá.</p>
        <div align="center"><b>O d ů v o d n ě n í :</b></div>
        <p>Soud přezkoumal.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNsDecisionHtml(input);

      const headings = documentAst.blocks.filter((b) => b.type === "heading");
      const oduv = headings.find(
        (h) =>
          h.plainText.includes("Odůvodnění") ||
          h.plainText.includes("O d ů v o d n ě n í"),
      );
      expect(oduv).toBeDefined();
    });
  });

  describe("holding zone tagging", () => {
    test("tags paragraphs between takto: and Odůvodnění as holding", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst } = parseNsDecisionHtml(input);

      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBeGreaterThan(0);

      // Holdings should contain ruling content
      const rulingTexts = holdings.map((h) => h.plainText);
      expect(rulingTexts.some((t) => t.includes("odmítá"))).toBe(true);
    });
  });

  describe("closing and signature", () => {
    test("detects closing formula", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst } = parseNsDecisionHtml(input);

      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).toContain("V Praze dne");
    });

    test("signature blocks are separate from closing", () => {
      const input = baseInput(minimalPrintHtml);
      const { documentAst } = parseNsDecisionHtml(input);

      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).not.toContain("JUDr.");

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.length).toBeGreaterThan(0);
      expect(sigs.some((s) => s.plainText.includes("JUDr."))).toBe(true);
      expect(sigs.some((s) => s.plainText.includes("předseda senátu"))).toBe(
        true,
      );
    });
  });

  describe("block merging", () => {
    test("merges continuation fragments starting with lowercase", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
        </tbody></table>
        <div align="center"><b>U S N E S E N Í</b></div>
        <p align="center"><b>Odůvodnění:</b></p>
        <p>Soud konstatoval, že žaloba</p>
        <p>je důvodná a žalobce má nárok</p>
        <p>na náhradu škody.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNsDecisionHtml(input);

      // The three fragments should merge into fewer blocks
      const paragraphs = documentAst.blocks.filter(
        (b) => b.type === "paragraph",
      );
      // They start with lowercase so should merge
      expect(paragraphs.length).toBeLessThanOrEqual(2);
    });

    test("merges fragments starting with comma or semicolon", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
        </tbody></table>
        <div align="center"><b>U S N E S E N Í</b></div>
        <p align="center"><b>Odůvodnění:</b></p>
        <p>Soud přezkoumal rozhodnutí</p>
        <p>, kterým bylo zamítnuto odvolání</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNsDecisionHtml(input);

      // The comma fragment should merge with previous
      const paras = documentAst.blocks.filter(
        (b) => b.type === "paragraph" && !("role" in b && b.role),
      );
      // Should be merged into one
      const merged = paras.find(
        (p) =>
          p.plainText.includes("přezkoumal") &&
          p.plainText.includes("zamítnuto"),
      );
      expect(merged).toBeDefined();
    });
  });

  describe("related proceedings table", () => {
    test("extracts ústavní stížnost table", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
          <tr><td colspan="2">ústavní stížnost
            <table>
              <tr><td>Spisová značka</td><td>Výsledek</td></tr>
              <tr><td>I.ÚS 100/25</td><td>odmítnuta</td></tr>
            </table>
          </td></tr>
        </tbody></table>
        <div align="center"><b>U S N E S E N Í</b></div>
        <p align="center"><b>Odůvodnění:</b></p>
        <p>Text.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst, sourceMetadata } = parseNsDecisionHtml(input);

      // Should have a related-proceedings table block
      const tableBlocks = documentAst.blocks.filter(
        (b) =>
          b.type === "table" && "role" in b && b.role === "related-proceedings",
      );
      expect(tableBlocks.length).toBeGreaterThan(0);

      // Source metadata should contain parsed ústavní stížnost
      expect(sourceMetadata["ustavniStiznost"]).toBeDefined();
    });
  });

  describe("content retention", () => {
    test("fulltext preserves all meaningful content", () => {
      const input = baseInput(minimalPrintHtml);
      const { fulltext } = parseNsDecisionHtml(input);

      expect(fulltext).toContain("Nejvyšší soud rozhodl");
      expect(fulltext).toContain("ALBA, a.s.");
      expect(fulltext).toContain("5 000 000 Kč");
      expect(fulltext).toContain("Dovolání se");
      expect(fulltext).toContain("odmítá");
      expect(fulltext).toContain("§ 237 o. s. ř.");
    });
  });

  describe("edge cases", () => {
    test("handles table in decision body", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
        </tbody></table>
        <div align="center"><b>U S N E S E N Í</b></div>
        <p align="center"><b>Odůvodnění:</b></p>
        <table>
          <tr>
            <td>Položka</td>
            <td>Částka</td>
          </tr>
          <tr>
            <td>Jistina</td>
            <td>1 000 000 Kč</td>
          </tr>
        </table>
        <p>Text po tabulce.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNsDecisionHtml(input);

      const tables = documentAst.blocks.filter((b) => b.type === "table");
      expect(tables.length).toBeGreaterThan(0);
    });

    test("handles embedded title in first paragraph", () => {
      // Older NS HTML: preamble + title in one block
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
        </tbody></table>
        <p>NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY 29 Odo 975/2006 U S N E S E N Í</p>
        <p align="center"><b>Odůvodnění:</b></p>
        <p>Text.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNsDecisionHtml(input);

      // Should extract the title from embedded paragraph
      const titles = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "decision-title",
      );
      expect(titles.length).toBeGreaterThan(0);
    });
  });
});
