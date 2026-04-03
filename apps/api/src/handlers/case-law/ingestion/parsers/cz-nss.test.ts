import { describe, expect, test } from "bun:test";

import type { Block } from "@/api/handlers/case-law/document-ast";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import type { ParseNssDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";

// ── Helpers ─────────────────────────────────────────────────

const baseInput = (
  html: string,
  overrides?: Partial<ParseNssDecisionInput>,
): ParseNssDecisionInput => ({
  caseNumber: "2 As 123/2025",
  ecli: "ECLI:CZ:NSS:2025:2.AS.123.2025.1",
  court: "Nejvyšší správní soud",
  decisionDate: "2025-03-15",
  decisionType: "rozsudek",
  sourceUrl: "https://vyhledavac.nssoud.cz/doc/123",
  html,
  detailMetadata: {},
  ...overrides,
});

const findByRole = (blocks: Block[], role: string) =>
  blocks.find((b) => "role" in b && b.role === role);

const findAllByRole = (blocks: Block[], role: string) =>
  blocks.filter((b) => "role" in b && b.role === role);

const findAllByType = (blocks: Block[], type: string) =>
  blocks.filter((b) => b.type === type);

// ── Minimal decision HTML ───────────────────────────────────

const minimalHtml = `
<html><body>
<p style="text-align:center">2 As 123/2025 - 42</p>
<p style="text-align:center">[OBRÁZEK]</p>
<p style="text-align:center">
  <span style="font-weight:bold">ROZSUDEK</span>
</p>
<p style="text-align:center">
  <span style="font-weight:bold">JMÉNEM REPUBLIKY</span>
</p>
<p>Nejvyšší správní soud rozhodl v senátě složeném
z předsedy JUDr. Karla Šimky a soudců JUDr. Filipa Dienstbiera
a JUDr. Petra Mikeše ve věci žalobce: město Kolín,
se sídlem Karlovo náměstí 78, Kolín, zastoupeného advokátem
Mgr. Janem Novákem, proti žalovanému: Ministerstvo životního
prostředí, se sídlem Vršovická 1442/65, Praha 10,
v řízení o kasační stížnosti žalobce proti rozsudku
Krajského soudu v Praze ze dne 12. 1. 2025,
čj. 43 A 15/2024 - 78,</p>
<p style="text-align:center">
  <span style="font-weight:bold;letter-spacing:3pt">
    t a k t o :
  </span>
</p>
<ol type="I">
  <li>Kasační stížnost se <span style="font-weight:bold">zamítá</span>.</li>
  <li>Žádný z účastníků <span style="font-weight:bold">nemá</span>
  právo na náhradu nákladů řízení o kasační stížnosti.</li>
</ol>
<p style="text-align:center">
  <span style="font-weight:bold">Odůvodnění:</span>
</p>
<p>[1] Žalobce (dále jen „stěžovatel") podal kasační stížnost
proti rozsudku Krajského soudu v Praze (dále jen „krajský
soud"), kterým byla zamítnuta jeho žaloba proti rozhodnutí
žalovaného ze dne 5. 6. 2024, čj. MZP/2024/560/123.</p>
<p>[2] Krajský soud v napadeném rozsudku konstatoval, že
žalovaný postupoval v souladu se zákonem č. 114/1992 Sb.,
o ochraně přírody a krajiny.</p>
<p style="text-align:center">
  <span style="font-weight:bold">Poučení:</span>
</p>
<p>Proti tomuto rozsudku nejsou opravné prostředky přípustné.</p>
<p>V Brně dne 15. března 2025</p>
<p style="text-align:center">JUDr. Karel Šimka</p>
<p style="text-align:center">předseda senátu</p>
</body></html>
`;

// ── Tests ───────────────────────────────────────────────────

describe("parseNssDecisionHtml", () => {
  describe("basic structure", () => {
    test("parses minimal decision into all sections", () => {
      const input = baseInput(minimalHtml);
      const { documentAst, fulltext } = parseNssDecisionHtml(input);

      // Has blocks
      expect(documentAst.blocks.length).toBeGreaterThan(0);

      // Has case number
      const caseNum = findByRole(documentAst.blocks, "case-number");
      expect(caseNum).toBeDefined();
      expect(caseNum?.plainText).toContain("2 As 123/2025");

      // Has decision title
      const titles = documentAst.blocks.filter(
        (b) =>
          b.type === "heading" && "role" in b && b.role === "decision-title",
      );
      expect(titles.length).toBeGreaterThan(0);

      // Has holdings
      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBe(2);
      expect(holdings[0]?.plainText).toContain("I.");
      expect(holdings[0]?.plainText).toContain("zamítá");

      // Has closing and signature
      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).toContain("V Brně dne");

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.length).toBeGreaterThan(0);

      // Fulltext includes all content
      expect(fulltext).toContain("Kasační stížnost se");
      expect(fulltext).toContain("stěžovatel");
      expect(fulltext).toContain("Krajský soud");
    });
  });

  describe("skip patterns", () => {
    test("skips [OBRÁZEK] lines", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const texts = documentAst.blocks.map((b) => b.plainText);
      expect(texts.some((t) => t.includes("[OBRÁZEK]"))).toBe(false);
    });

    test("skips pokračování lines", () => {
      const html = `<html><body>
        <p style="text-align:center">pokračování</p>
        <p style="text-align:center">2 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p>Soud rozhodl takto:</p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>[1] Soud přezkoumal napadený rozsudek.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const texts = documentAst.blocks.map((b) => b.plainText);
      expect(texts.some((t) => t === "pokračování")).toBe(false);
    });
  });

  describe("section separators", () => {
    test("normalizes spaced t a k t o : to takto:", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const takto = headings.find((h) => h.plainText === "takto:");
      expect(takto).toBeDefined();
      expect(takto?.type).toBe("heading");
    });

    test("normalizes Odůvodnění to canonical form", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const oduv = headings.find((h) => h.plainText === "Odůvodnění:");
      expect(oduv).toBeDefined();
    });

    test("normalizes Poučení to canonical form", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const pouc = headings.find((h) => h.plainText === "Poučení:");
      expect(pouc).toBeDefined();
    });

    test("handles inline Poučení: with text", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>[1] Text odůvodnění.</p>
        <p><span style="font-weight:bold">Poučení: Proti tomuto rozsudku nejsou opravné prostředky přípustné.</span></p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const pouc = headings.find((h) => h.plainText === "Poučení:");
      expect(pouc).toBeDefined();

      // The rest of the text should be a separate paragraph
      const afterPouc = documentAst.blocks.find(
        (b) =>
          b.type === "paragraph" && b.plainText.includes("opravné prostředky"),
      );
      expect(afterPouc).toBeDefined();
    });
  });

  describe("numbered paragraphs", () => {
    test("strips [N] prefix from numbered paragraphs", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      // Paragraphs should not start with [1] or [2]
      const numberedParas = documentAst.blocks.filter(
        (b) => b.type === "paragraph" && /^\[\d+\]/.test(b.plainText),
      );
      expect(numberedParas.length).toBe(0);

      // But the content should be preserved
      const stezovatel = documentAst.blocks.find(
        (b) => b.type === "paragraph" && b.plainText.includes("stěžovatel"),
      );
      expect(stezovatel).toBeDefined();
    });
  });

  describe("ordered list ruling items", () => {
    test("converts <ol> items to holding paragraphs with Roman prefix", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBeGreaterThanOrEqual(2);
      expect(holdings[0]?.plainText).toMatch(/^I\.\s/);
      expect(holdings[1]?.plainText).toMatch(/^II\.\s/);
    });

    test("handles <ol start=N> attribute", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold;letter-spacing:3pt">
            t a k t o :
          </span>
        </p>
        <ol type="I" start="3">
          <li>Třetí výrok.</li>
        </ol>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>[1] Text.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBe(1);
      expect(holdings[0]?.plainText).toMatch(/^III\.\s/);
    });
  });

  describe("section headings in Odůvodnění", () => {
    test("detects Roman numeral section headings", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">
            III. Posouzení Nejvyšším správním soudem
          </span>
        </p>
        <p>[1] Text odůvodnění.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const h3s = documentAst.blocks.filter(
        (b) => b.type === "heading" && "level" in b && b.level === 3,
      );
      expect(h3s.length).toBeGreaterThan(0);
      expect(h3s[0]?.plainText).toContain("Posouzení");
    });
  });

  describe("closing and signature", () => {
    test("classifies V Brně dne as closing", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).toContain("V Brně dne");
    });

    test("classifies předseda senátu as signature", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      const sigs = findAllByRole(documentAst.blocks, "signature");
      expect(sigs.length).toBeGreaterThan(0);
      const predseda = sigs.find((s) =>
        s.plainText.includes("předseda senátu"),
      );
      expect(predseda).toBeDefined();
    });
  });

  describe("bold formatting", () => {
    test("preserves bold spans in inlines", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      // The ruling items contain bold "zamítá"
      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBeGreaterThan(0);

      // Check that bold inlines exist somewhere
      const hasBold = holdings.some(
        (h) =>
          h.type !== "table" &&
          h.inlines.some(
            (i) =>
              i.type === "bold" ||
              ("children" in i && i.children.some((c) => c.type === "bold")),
          ),
      );
      expect(hasBold).toBe(true);
    });
  });

  describe("metadata", () => {
    test("populates DocumentAst metadata correctly", () => {
      const input = baseInput(minimalHtml);
      const { documentAst } = parseNssDecisionHtml(input);

      expect(documentAst.version).toBe(1);
      expect(documentAst.source.system).toBe("nssoud.cz");
      expect(documentAst.metadata.caseNumber).toBe("2 As 123/2025");
      expect(documentAst.metadata.ecli).toBe(
        "ECLI:CZ:NSS:2025:2.AS.123.2025.1",
      );
      expect(documentAst.metadata.court).toBe("Nejvyšší správní soud");
    });
  });

  describe("edge cases", () => {
    test("handles decision with no ruling items", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">USNESENÍ</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>[1] Soud přezkoumal.</p>
        <p>V Brně dne 1. ledna 2025</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const holdings = findAllByRole(documentAst.blocks, "holding");
      expect(holdings.length).toBe(0);
      expect(documentAst.blocks.length).toBeGreaterThan(0);
    });

    test("handles spaced Odůvodnění variant", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold;letter-spacing:3pt">
            O d ů v o d n ě n í :
          </span>
        </p>
        <p>[1] Text.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const headings = findAllByType(documentAst.blocks, "heading");
      const oduv = headings.find((h) => h.plainText === "Odůvodnění:");
      expect(oduv).toBeDefined();
    });

    test("Aspose spacer spans are skipped", () => {
      const html = `<html><body>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>
          <span style="-aw-import:ignore">   </span>
          <span>Skutečný text paragrafu.</span>
        </p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const para = documentAst.blocks.find(
        (b) => b.type === "paragraph" && b.plainText.includes("Skutečný text"),
      );
      expect(para).toBeDefined();
      // The spacer span text should not appear
      expect(para?.plainText).not.toMatch(/^\s{3}/);
    });

    test("preserves words inside Aspose spacer spans (old exports)", () => {
      const html = `<html><body>
        <p style="text-align:center">5 Azs 250/2004</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>
          <span style="-aw-import:spaces">písemnou smlouvu</span>
          <span> opatřenou podpisy obou stran.</span>
        </p>
        <p>
          <span>Žalobce předložil </span>
          <span style="display:inline-block; width:36pt">důkaz</span>
          <span> o doručení.</span>
        </p>
      </body></html>`;

      const input = baseInput(html, { caseNumber: "5 Azs 250/2004" });
      const { fulltext } = parseNssDecisionHtml(input);

      // Words inside -aw-import:spaces must be preserved
      expect(fulltext).toContain("písemnou smlouvu");
      // Words inside display:inline-block must be preserved
      expect(fulltext).toContain("důkaz");
    });

    test("handles ČESKÁ REPUBLIKA skip", () => {
      const html = `<html><body>
        <p style="text-align:center">ČESKÁ REPUBLIKA</p>
        <p style="text-align:center">1 As 1/2025</p>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>[1] Text.</p>
      </body></html>`;

      const input = baseInput(html);
      const { documentAst } = parseNssDecisionHtml(input);

      const texts = documentAst.blocks.map((b) => b.plainText);
      expect(texts).not.toContain("ČESKÁ REPUBLIKA");
    });
  });

  // ── Content retention ───────────────────────────────────

  describe("content retention", () => {
    test("fulltext contains meaningful content from all sections", () => {
      const input = baseInput(minimalHtml);
      const { fulltext } = parseNssDecisionHtml(input);

      // Ruling
      expect(fulltext).toContain("zamítá");
      expect(fulltext).toContain("náhradu nákladů");

      // Reasoning
      expect(fulltext).toContain("stěžovatel");
      expect(fulltext).toContain("Krajský soud");
      expect(fulltext).toContain("114/1992 Sb.");

      // Poučení
      expect(fulltext).toContain("opravné prostředky");
    });
  });
});
