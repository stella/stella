import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  blocksToPlainText,
  extractNsMetadata,
  extractRawChunks,
  parseNsDecisionHtml,
} from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import type { ParseNsDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";

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

describe("list text", () => {
  test("keeps bare text in ordered and unordered lists in source order", () => {
    const input = baseInput(`
      ${metaTableHtml}
      <ul>before unordered <li>first item</li>between unordered<li>second item</li>after unordered</ul>
      <ol>before ordered <li>third item</li>between ordered<li>fourth item</li>after ordered</ol>
    `);

    const { fulltext } = parseNsDecisionHtml(input);

    const expectedOrder = [
      "before unordered",
      "first item",
      "between unordered",
      "second item",
      "after unordered",
      "before ordered",
      "third item",
      "between ordered",
      "fourth item",
      "after ordered",
    ];
    const positions = expectedOrder.map((text) => fulltext.indexOf(text));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      positions.toSorted((left, right) => left - right),
    );
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
    test.each([
      { copies: 1, headerTag: "td" },
      { copies: 2, headerTag: "td" },
      { copies: 4, headerTag: "td" },
      { copies: 1, headerTag: "th" },
      { copies: 2, headerTag: "th" },
      { copies: 4, headerTag: "th" },
    ])(
      "normalizes repeated complaint values while preserving source text ($copies copies, $headerTag headers)",
      ({ copies, headerTag }) => {
        const date = Array.from({ length: copies }, () => "05/25/2022").join(
          "<br><br>",
        );
        const docket = Array.from(
          { length: copies },
          () => "IV.ÚS 1381/22",
        ).join("<br><br>");
        const html = `<table id="box-table-a"><tr><td colspan="2">Podána ústavní stížnost
        <table><tr><${headerTag}>datum podání</${headerTag}><${headerTag}>spisová značka</${headerTag}></tr>
        <tr><td>${date}</td><td>${docket}</td></tr></table></td></tr></table>`;
        const { source } = extractNsMetadata(cheerio.load(html));
        const row = source.ustavniStiznost?.at(0);
        expect(row?.["datum podání"]).toEqual({
          type: "date",
          value: "2022-05-25",
          sourceValue: Array.from({ length: copies }, () => "05/25/2022").join(
            "\n\n",
          ),
          defects:
            copies > 1
              ? ["duplicated-value", "embedded-newlines", "us-date-format"]
              : ["us-date-format"],
        });
        expect(row?.["spisová značka"]).toMatchObject({
          type: "text",
          value: "IV.ÚS 1381/22",
        });
      },
    );

    test.each([
      { date: "02/30/2022", defects: ["us-date-format", "invalid-date"] },
      {
        date: "05/25/2022<br>05/26/2022",
        defects: ["embedded-newlines", "us-date-format", "conflicting-values"],
      },
      { date: "unknown", defects: ["invalid-date"] },
    ])(
      "leaves an unresolved source date intact: $date",
      ({ date, defects }) => {
        const html = `<table id="box-table-a"><tr><td colspan="2">Podána ústavní stížnost
        <table><tr><td>datum podání</td></tr><tr><td>${date}</td></tr></table>
        </td></tr><tr><td>Datum rozhodnutí:</td><td>05/27/2022</td></tr></table>`;
        const { source } = extractNsMetadata(cheerio.load(html));
        expect(source.ustavniStiznost?.at(0)?.["datum podání"]).toEqual({
          type: "unresolved-date",
          sourceValue: date.replace("<br>", "\n"),
          defects,
        });
      },
    );

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
      expect(sourceMetadata.ustavniStiznost).toBeDefined();
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
      // The court's name before the case number is kept, not dropped.
      expect(documentAst.blocks.slice(0, 3).map((b) => b.plainText)).toEqual([
        "NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY",
        "29 Odo 975/2006",
        "U S N E S E N Í",
      ]);
    });

    // An older print page prints each caption line in its own run, and the
    // parser merges them: the title is every capital after the case number,
    // not the tail after the first capital standing before a space.
    test("keeps a whole run-on caption title", () => {
      const html = `<html><body>
        <table id="box-table-a"><tbody>
          <tr><td>Soud:</td><td>NS</td></tr>
        </tbody></table>
        <br><p><br>
        <font face="Arial CE">21 Cdo 4994/2007</font><br>
        <br>
        <font face="Arial CE">ČESKÁ REPUBLIKA </font><br>
        <br>
        <font face="Arial CE">ROZSUDEK</font><br>
        <br>
        <font face="Arial CE">JMÉNEM REPUBLIKY</font><br>
        <br>
        <font face="Arial CE">Nejvyšší soud České republiky rozhodl v senátě takto:</font><br>
        </p>
      </body></html>`;

      const { documentAst, fulltext } = parseNsDecisionHtml(baseInput(html));

      const [caseNumber, title] = documentAst.blocks;
      expect(caseNumber).toMatchObject({
        plainText: "21 Cdo 4994/2007",
        role: "case-number",
        type: "paragraph",
      });
      expect(title).toMatchObject({ role: "decision-title", type: "heading" });
      expect(title?.plainText.replaceAll(/\s+/gu, " ")).toBe(
        "ČESKÁ REPUBLIKA ROZSUDEK JMÉNEM REPUBLIKY",
      );
      expect(fulltext).toContain("ČESKÁ REPUBLIKA");
    });
  });
});

describe("source table text retention", () => {
  test("preserves breaks in unknown, additional and recognized metadata cells", () => {
    for (const separator of [
      "<br>",
      "<br/>",
      "<BR />",
      "&lt;br&gt;",
      "&lt;br/&gt;",
      "&lt;BR /&gt;",
    ]) {
      const { canonical, source } = extractNsMetadata(
        cheerio.load(`<table id="box-table-a">
          <tr><th>Unknown${separator}label</th>
            <td>${separator}<b>foo${separator}bar</b>${separator}baz</td>
            <td>extra${separator}value</td></tr>
          <tr><td>Kategorie rozhodnutí:</td><td>foo${separator}bar</td></tr>
          <tr><td>Heslo:</td><td>${separator}foo${separator}bar</td></tr>
          <tr><td>Dotčené předpisy:</td><td>${separator}foo${separator}bar</td></tr>
          <tr><th>Standalone${separator}header</th></tr>
        </table>`),
      );
      expect(source["metadataTable"]).toEqual({
        captions: [],
        rows: [
          [
            { type: "header", text: "Unknown\nlabel" },
            { type: "data", text: "foo\nbar\nbaz" },
            { type: "data", text: "extra\nvalue" },
          ],
          [
            { type: "data", text: "Kategorie rozhodnutí:" },
            { type: "data", text: "foo\nbar" },
          ],
          [
            { type: "data", text: "Heslo:" },
            { type: "data", text: "foo\nbar" },
          ],
          [
            { type: "data", text: "Dotčené předpisy:" },
            { type: "data", text: "foo\nbar" },
          ],
          [{ type: "header", text: "Standalone\nheader" }],
        ],
      });
      expect(source["kategorieRozhodnuti"]).toBe("foo\nbar");
      expect(canonical.keywords).toEqual(["foo", "bar"]);
      expect(canonical.statutes).toEqual(canonical.keywords);
    }
  });

  test("escaped metadata breaks retain ordered values like HTML breaks", () => {
    const values = [
      "odmítnuto pro zjevnou neopodstatněnost",
      "odmítnuto pro neoprávněnost navrhovatele",
      "odmítnuto pro nepříslušnost",
    ];
    const fixture = (separator: string) => `<html><body>
      <table id="box-table-a">
        <tr><td>Senátní značka:</td><td>29 ICdo 37/2013</td></tr>
        <tr><td>Heslo:</td><td>${separator}${values.join(separator)}</td></tr>
        <tr><td colspan="2">Podána ústavní stížnost
          <table><tr><td>Výsledek</td></tr>
            <tr><td><font>${separator}${values.join(separator)}</font></td></tr>
          </table>
        </td></tr>
      </table>
      <p>Text rozhodnutí zůstává zachován.</p>
    </body></html>`;
    const expected = parseNsDecisionHtml(baseInput(fixture("<br/>")));
    for (const separator of ["&lt;br&gt;", "&lt;br/&gt;", "&lt;BR /&gt;"]) {
      const result = parseNsDecisionHtml(baseInput(fixture(separator)));
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
      expect(result.metadata.caseNumber).toBe("29 ICdo 37/2013");
      expect(result.metadata.keywords).toEqual(values);
      expect(
        result.sourceMetadata.ustavniStiznost?.at(0)?.["výsledek"],
      ).toMatchObject({
        type: "text",
        value: values.join("\n"),
      });
      expect(
        result.documentAst.blocks.every(
          (block) => markupResidueIn(block.plainText) === undefined,
        ),
      ).toBe(true);
      expect(result.fulltext).toContain(values.join("\n"));
      expect(result.fulltext).toContain("Text rozhodnutí zůstává zachován.");
    }
  });

  test("keeps every metadata cell and caption without inferring labels", () => {
    const { source } = extractNsMetadata(
      cheerio.load(`<table id="box-table-a">
      <caption>Metadata caption</caption>
      <tr><th>Soud:</th><td>Named court</td><td>Extra value</td></tr>
      <tr><td>Unknown label</td><td>Unknown value</td></tr>
      <tr><th>Standalone header</th></tr>
    </table>`),
    );
    expect(source["metadataTable"]).toEqual({
      captions: ["Metadata caption"],
      rows: [
        [
          { type: "header", text: "Soud:" },
          { type: "data", text: "Named court" },
          { type: "data", text: "Extra value" },
        ],
        [
          { type: "data", text: "Unknown label" },
          { type: "data", text: "Unknown value" },
        ],
        [{ type: "header", text: "Standalone header" }],
      ],
    });
  });

  test("keeps body captions and header cells in source order", () => {
    const result = parseNsDecisionHtml(
      baseInput(`<html><body>
      <table id="box-table-a"></table>
      <table><caption>Body caption</caption><tr><th>Column heading</th><td>First cell</td><td>Last cell</td></tr></table>
    </body></html>`),
    );
    expect(result.fulltext).toBe(
      "Body caption\n\nColumn heading\tFirst cell\tLast cell",
    );
    const table = result.documentAst.blocks.find(
      (block) => block.type === "table",
    );
    expect(table?.rows.at(0)?.at(0)?.header).toBe(true);
  });
});

test("retains a nested table inside its outer cell once", () => {
  const parsed = parseNsDecisionHtml(
    baseInput(
      '<table id="box-table-a"></table><table><tr><td>Outer<table><tr><td>qzmarkerInner</td></tr></table></td></tr></table>',
    ),
  );
  const tables = parsed.documentAst.blocks.filter(
    (block) => block.type === "table",
  );
  expect(tables).toHaveLength(1);
  expect(tables.at(0)?.rows).toHaveLength(1);
  expect(tables.at(0)?.rows.at(0)?.at(0)?.plainText).toBe("OuterqzmarkerInner");
  expect(parsed.fulltext.split("qzmarkerInner").length - 1).toBe(1);
});

for (const tag of ["script", "style"]) {
  test(`ignores ${tag} text in metadata captions and values`, () => {
    const clean = `<table id="box-table-a"><caption>Metadata</caption><tbody>
      <tr><td>Soud:</td><td>Nejvyšší soud</td></tr>
      <tr><td>Heslo:</td><td>Dovolání<br/>Přípustnost dovolání</td></tr>
    </tbody></table>`;
    const hidden = `<${tag}>qzmetadataHidden</${tag}>`;
    const injected = clean
      .replace("Metadata", () => `Metadata${hidden}`)
      .replace("Nejvyšší soud", () => `Nejvyšší soud${hidden}`)
      .replace("Dovolání<br/>", () => `Dovolání${hidden}<br/>`);
    expect(injected).not.toBe(clean);
    expect(extractNsMetadata(cheerio.load(injected))).toEqual(
      extractNsMetadata(cheerio.load(clean)),
    );
  });
}

test("retains metadata footer rows through the shared row owner", () => {
  const { source } = extractNsMetadata(
    cheerio.load(`<table id="box-table-a">
    <tbody><tr><td>Soud:</td><td>Nejvyšší soud</td></tr></tbody>
    <tfoot><tr><td>Dodatečná informace:</td><td>Source footer</td></tr></tfoot>
  </table>`),
  );
  expect(source["metadataTable"]).toEqual({
    captions: [],
    rows: [
      [
        { type: "data", text: "Soud:" },
        { type: "data", text: "Nejvyšší soud" },
      ],
      [
        { type: "data", text: "Dodatečná informace:" },
        { type: "data", text: "Source footer" },
      ],
    ],
  });
});
