import { describe, expect, test } from "bun:test";

import type { Block } from "@/api/handlers/case-law/document-ast";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import type { ParseUsDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-us";

// ── Helpers ─────────────────────────────────────────────────

const baseInput = (
  html: string,
  overrides?: Partial<ParseUsDecisionInput>,
): ParseUsDecisionInput => ({
  html,
  caseNumber: "I.ÚS 100/25",
  ecli: "ECLI:CZ:US:2025:1.US.100.25.1",
  court: "Ústavní soud",
  decisionDate: "2025-02-10",
  decisionType: undefined,
  ...overrides,
});

const findByRole = (blocks: Block[], role: string) =>
  blocks.find((b) => "role" in b && b.role === role);

const findAllByRole = (blocks: Block[], role: string) =>
  blocks.filter((b) => "role" in b && b.role === role);

const findAllByType = (blocks: Block[], type: string) =>
  blocks.filter((b) => b.type === type);

// ── RTF-based decision (post-2007) ──────────────────────────

const rtfContent = [
  "\\pard\\b Ústavní soud rozhodl v senátu složeném z předsedy senátu",
  "JUDr. Tomáše Lichovníka a soudců JUDr. Vladimíra Sládečka",
  "a JUDr. Davida Uhlíře ve věci ústavní stížnosti stěžovatele",
  "J. K., zastoupeného Mgr. Petrem Novákem, advokátem se sídlem",
  "Praha 2, Vinohradská 100,\\b0  směřující proti rozsudku Nejvyššího",
  "správního soudu ze dne 15. ledna 2025 č. j. 2 As 50/2024 - 78,",
  "\\par",
  "t a k t o :",
  "\\par",
  "I. Rozsudkem Nejvyššího správního soudu ze dne 15. ledna 2025",
  "č. j. 2 As 50/2024 - 78 bylo porušeno právo stěžovatele na",
  "spravedlivý proces zaručené článkem 36 odst. 1 Listiny základních",
  "práv a svobod.",
  "\\par",
  "II. Rozsudek Nejvyššího správního soudu ze dne 15. ledna 2025",
  "č. j. 2 As 50/2024 - 78 se zrušuje.",
  "\\par",
  "O d ů v o d n ě n í :",
  "\\par",
  "I.",
  "\\par",
  "Vymezení věci a rekapitulace řízení",
  "\\par",
  "1. Ústavní stížností, doručenou Ústavnímu soudu dne 5. 2. 2025,",
  "se stěžovatel domáhal zrušení v záhlaví označeného rozsudku",
  "Nejvyššího správního soudu.",
  "\\par",
  "2. Z ústavní stížnosti a přiložených listin vyplývá, že",
  "stěžovatel podal kasační stížnost, která byla zamítnuta.",
  "\\par",
  "II.",
  "\\par",
  "Posouzení Ústavním soudem",
  "\\par",
  "3. Ústavní soud přezkoumal napadené rozhodnutí z hlediska",
  "tvrzeného porušení ústavně zaručených práv a dospěl k závěru,",
  "že ústavní stížnost je důvodná.",
  "\\par",
  "4. Ústavní soud opakovaně judikoval, že právo na spravedlivý",
  "proces zahrnuje i právo na řádné odůvodnění soudního rozhodnutí",
  "(viz nález sp. zn. III.ÚS 84/94).",
  "\\par",
  "V Brně dne 10. února 2025",
  "\\par",
  "JUDr. Tomáš Lichovník v. r.",
  "\\par",
  "předseda senátu",
].join("\n");

const rtfDecisionHtml = `
<html><body>
  <span id="lblDecisionForm">NÁLEZ</span>
  <input id="docContentHidden" value="${rtfContent}" />
  <input id="registrySignHidden" value="I.ÚS 100/25 #1" />
  <input id="paralellQuotationHidden" value="" />
  <input id="popularNameHidden" value="" />
  <input id="docIdHidden" value="99999" />
  <div class="DocContent">
    <p>Ústavní soud rozhodl...</p>
  </div>
</body></html>
`;

// ── HTML-fallback decision (pre-2007) ───────────────────────

const docContentOnlyHtml = `
<html><body>
  <span id="lblDecisionForm">USNESENÍ</span>
  <input id="docContentHidden" value="" />
  <input id="docIdHidden" value="11111" />
  <div class="DocContent">
    Ústavní soud rozhodl v senátu ve věci ústavní stížnosti
    stěžovatele, takto: Ústavní stížnost se odmítá.Odůvodnění:
    Ústavní soud přezkoumal podání stěžovatele a shledal, že
    ústavní stížnost je zjevně neopodstatněná.V Brně dne
    5. května 2005 JUDr. Pavel Rychetský předseda senátu
  </div>
</body></html>
`;

// ── Tests ───────────────────────────────────────────────────

describe("parseUsDecisionHtml", () => {
  describe("RTF extraction (post-2007)", () => {
    test("prefers docContentHidden RTF over visible HTML", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst, fulltext } = parseUsDecisionHtml(input);

      // Should have blocks from RTF, not from the
      // crammed DocContent HTML
      expect(documentAst.blocks.length).toBeGreaterThan(5);
      expect(fulltext).toContain("stěžovatel");
      expect(fulltext).toContain("spravedlivý proces");
    });

    test("parses RTF bold markers into inline bold", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      // First paragraph should have bold content
      // (the RTF starts with \b ... \b0)
      const hasBoldBlock = documentAst.blocks.some(
        (b) =>
          b.type !== "table" &&
          b.inlines.some(
            (i) =>
              i.type === "bold" ||
              ("children" in i && i.children.some((c) => c.type === "bold")),
          ),
      );
      expect(hasBoldBlock).toBe(true);
    });

    test("strips uppercase RTF formatting control words", () => {
      const html = `
      <html><body>
        <span id="lblDecisionForm">NÁLEZ</span>
        <input id="docContentHidden" value="\\PARD\\FS24\\CF1 Ústavní soud rozhodl.\\PAR t a k t o :" />
        <input id="docIdHidden" value="99999" />
      </body></html>
      `;

      const { fulltext } = parseUsDecisionHtml(baseInput(html));

      expect(fulltext).toContain("Ústavní soud rozhodl");
      expect(fulltext).toContain("takto:");
      expect(fulltext).not.toContain("\\FS24");
      expect(fulltext).not.toContain("\\CF1");
      expect(fulltext).not.toContain("\\PAR");
    });
  });

  describe("hidden field metadata", () => {
    test("extracts decision form from lblDecisionForm", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      expect(documentAst.metadata.decisionType).toBe("NÁLEZ");
    });

    test("extracts docId from hidden field", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      expect(documentAst.source.documentId).toBe("99999");
    });

    test("synthesizes decision title from decision form", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title).toBeDefined();
      expect(title?.plainText).toBe("NÁLEZ");
    });
  });

  describe("section detection", () => {
    test("detects takto: separator (spaced variant)", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const takto = headings.find((h) => h.plainText === "takto:");
      expect(takto).toBeDefined();
    });

    test("detects Odůvodnění separator (spaced variant)", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const oduv = headings.find((h) => h.plainText === "Odůvodnění:");
      expect(oduv).toBeDefined();
    });
  });

  describe("ruling zone", () => {
    test("tags content between takto: and Odůvodnění: as holding", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBeGreaterThan(0);

      const holdingTexts = holdings.map((h) => h.plainText);
      expect(holdingTexts.some((t) => t.includes("porušeno právo"))).toBe(true);
      expect(holdingTexts.some((t) => t.includes("zrušuje"))).toBe(true);
    });
  });

  describe("Odůvodnění zone", () => {
    test("detects Roman numeral section headings", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const h3s = documentAst.blocks.filter(
        (b) => b.type === "heading" && "level" in b && b.level === 3,
      );
      expect(h3s.length).toBeGreaterThanOrEqual(2);
      expect(h3s.some((h) => h.plainText.includes("Vymezení"))).toBe(true);
      expect(h3s.some((h) => h.plainText.includes("Posouzení"))).toBe(true);
    });

    test("strips numbered prefix from paragraphs", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      // No paragraph should start with "1. " or "2. "
      const numberedParas = documentAst.blocks.filter(
        (b) => b.type === "paragraph" && /^\d+\.\s/u.test(b.plainText),
      );
      expect(numberedParas.length).toBe(0);

      // Content should be preserved
      expect(
        documentAst.blocks.some(
          (b) =>
            b.type === "paragraph" && b.plainText.includes("Ústavní stížností"),
        ),
      ).toBe(true);
    });
  });

  describe("closing and signature", () => {
    test("detects closing formula", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).toContain("V Brně dne");
    });

    test("detects signature with v.r.", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.length).toBeGreaterThan(0);
    });

    test("detects předseda senátu as signature", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.some((s) => s.plainText.includes("předseda"))).toBe(true);
    });

    test("detects judge name with academic title", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.some((s) => s.plainText.includes("JUDr."))).toBe(true);
    });
  });

  describe("cross-references", () => {
    test("extracts cross-reference links", () => {
      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="\\par Text rozhodnutí\\par V Brně dne 1. ledna 2025" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent">
            <p>Viz <a href="GetRegSignDecisions.aspx?sz=III.ÚS 84/94">III.ÚS 84/94</a>
            a <a href="GetRegSignDecisions.aspx?sz=I.ÚS 50/03">I.ÚS 50/03</a>.</p>
            <p>Také <a href="https://other-site.cz">irelevantní odkaz</a>.</p>
          </div>
        </body></html>
      `;

      const input = baseInput(html);
      const { crossReferences } = parseUsDecisionHtml(input);

      expect(crossReferences.length).toBe(2);
      expect(crossReferences[0]?.caseNumber).toBe("III.ÚS 84/94");
      expect(crossReferences[1]?.caseNumber).toBe("I.ÚS 50/03");
    });

    test("deduplicates cross-references", () => {
      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="\\par Text\\par V Brně dne 1. ledna 2025" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent">
            <p><a href="GetRegSignDecisions.aspx?sz=I.ÚS 1/01">I.ÚS 1/01</a>
            a <a href="GetRegSignDecisions.aspx?sz=I.ÚS 1/01">I.ÚS 1/01</a>.</p>
          </div>
        </body></html>
      `;

      const input = baseInput(html);
      const { crossReferences } = parseUsDecisionHtml(input);

      expect(crossReferences.length).toBe(1);
    });

    test("ignores non-GetRegSign links", () => {
      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="\\par Text\\par V Brně dne 1. ledna 2025" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent">
            <p><a href="https://example.com">Example</a></p>
          </div>
        </body></html>
      `;

      const input = baseInput(html);
      const { crossReferences } = parseUsDecisionHtml(input);

      expect(crossReferences.length).toBe(0);
    });
  });

  describe("HTML fallback (pre-2007)", () => {
    test("falls back to DocContent when RTF is empty", () => {
      const input = baseInput(docContentOnlyHtml);
      const { documentAst, fulltext } = parseUsDecisionHtml(input);

      expect(documentAst.blocks.length).toBeGreaterThan(0);
      expect(fulltext).toContain("Ústavní soud");
    });

    test("splits crammed text at paragraph boundaries", () => {
      const input = baseInput(docContentOnlyHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      // Should have been split at "Odůvodnění:" boundary
      // The exact split depends on heuristics, but we
      // should have more than 1 block
      expect(documentAst.blocks.length).toBeGreaterThan(1);
    });
  });

  describe("skip patterns", () => {
    test("skips Česká republika decorative line", () => {
      const rtf = [
        "Česká republika",
        "\\par",
        "Text rozhodnutí.",
        "\\par",
        "V Brně dne 1. ledna 2025",
      ].join("\n");

      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"><p>Text</p></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { documentAst } = parseUsDecisionHtml(input);

      const texts = documentAst.blocks.map((b) => b.plainText);
      expect(texts).not.toContain("Česká republika");
    });

    test("skips ČESKÁ REPUBLIKA decorative line", () => {
      const rtf = [
        "ČESKÁ REPUBLIKA",
        "\\par",
        "Text rozhodnutí.",
        "\\par",
        "V Brně dne 1. ledna 2025",
      ].join("\n");

      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"><p>Text</p></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { documentAst } = parseUsDecisionHtml(input);

      const texts = documentAst.blocks.map((b) => b.plainText);
      expect(texts).not.toContain("ČESKÁ REPUBLIKA");
    });
  });

  describe("title detection", () => {
    test("detects N Á L E Z (spaced) as title", () => {
      const rtf = [
        "N Á L E Z",
        "\\par",
        "Ústavní soud rozhodl.",
        "\\par",
        "V Brně dne 1. ledna 2025",
      ].join("\n");

      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"><p>Text</p></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { documentAst } = parseUsDecisionHtml(input);

      const titles = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "decision-title",
      );
      // At least one title (either from RTF or synthesized)
      expect(titles.length).toBeGreaterThan(0);
    });

    test("detects USNESENÍ as title", () => {
      const rtf = [
        "USNESENÍ",
        "\\par",
        "Ústavní soud rozhodl.",
        "\\par",
        "V Brně dne 1. ledna 2025",
      ].join("\n");

      const html = `
        <html><body>
          <span id="lblDecisionForm">USNESENÍ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"><p>Text</p></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { documentAst } = parseUsDecisionHtml(input);

      const titles = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "decision-title",
      );
      expect(titles.length).toBeGreaterThan(0);
    });
  });

  describe("metadata", () => {
    test("populates DocumentAst metadata", () => {
      const input = baseInput(rtfDecisionHtml);
      const { documentAst } = parseUsDecisionHtml(input);

      expect(documentAst.version).toBe(1);
      expect(documentAst.source.system).toBe("nalus.usoud.cz");
      expect(documentAst.metadata.caseNumber).toBe("I.ÚS 100/25");
      expect(documentAst.metadata.ecli).toBe("ECLI:CZ:US:2025:1.US.100.25.1");
      expect(documentAst.metadata.court).toBe("Ústavní soud");
    });
  });

  describe("content retention", () => {
    test("fulltext preserves meaningful legal content", () => {
      const input = baseInput(rtfDecisionHtml);
      const { fulltext } = parseUsDecisionHtml(input);

      expect(fulltext).toContain("stěžovatel");
      expect(fulltext).toContain("spravedlivý proces");
      expect(fulltext).toContain("Listiny základních");
      expect(fulltext).toContain("zrušuje");
      expect(fulltext).toContain("Ústavní stížností");
      expect(fulltext).toContain("kasační stížnost");
      expect(fulltext).toContain("III.ÚS 84/94");
    });
  });

  describe("edge cases", () => {
    test("handles empty RTF and empty DocContent", () => {
      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { documentAst } = parseUsDecisionHtml(input);

      // Should still have the synthesized title
      expect(documentAst.blocks.length).toBeGreaterThanOrEqual(1);
    });

    test("handles RTF with special characters", () => {
      const rtf = [
        "Text s diakritikou: šťáva, říční, ůdolí.",
        "\\par",
        "Částka: 1 500 000 Kč.",
        "\\par",
        "V Brně dne 1. ledna 2025",
      ].join("\n");

      const html = `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="12345" />
          <div class="DocContent"><p>Text</p></div>
        </body></html>
      `;

      const input = baseInput(html);
      const { fulltext } = parseUsDecisionHtml(input);

      expect(fulltext).toContain("šťáva");
      expect(fulltext).toContain("1 500 000 Kč");
    });
  });
});
