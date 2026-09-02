import { describe, expect, test } from "bun:test";

import { hasBlockInlines } from "@/api/handlers/case-law/document-ast";
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

const bold = (text: string): string =>
  `<p style="text-align:center"><span style="font-weight:bold">${text}</span></p>`;

const TRAILING_PUNCTUATION_RE = /[,:;.!?]$/u;

const splitTrailingPunctuation = (
  sentence: string,
): { body: string; punctuation: string } => {
  const punctuation = TRAILING_PUNCTUATION_RE.exec(sentence)?.[0] ?? "";
  return {
    body: punctuation ? sentence.slice(0, -punctuation.length) : sentence,
    punctuation,
  };
};

/** Render a sentence the way a publisher letter-spaces it for emphasis. */
const letterSpace = (sentence: string, gap: string): string => {
  const { body, punctuation } = splitTrailingPunctuation(sentence);
  const spaced = body
    .split(" ")
    .map((word) => word.split("").join(" "))
    .join(gap);
  return punctuation ? `${spaced} ${punctuation}` : spaced;
};

/** One emphasis wrapper per letter, the shape Aspose exports. */
const perLetterWrappers = (sentence: string, wordGap: () => string): string => {
  const letterGap = `<span style="font-weight:bold">&nbsp;</span>`;
  return sentence
    .split(" ")
    .map((word) =>
      word
        .split("")
        .map((letter) => `<span style="font-weight:bold">${letter}</span>`)
        .join(letterGap),
    )
    .join(wordGap());
};

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

    test("canonicalizes publisher-spaced decision titles as centred headings", () => {
      const html = `<html><body>
        <p style="text-align:center">4 As 3/2008 - 78</p>
        <p style="text-align:center">
          <span style="font-weight:bold">R O Z</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">S</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">U D E K</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">J M É N E M</span>
          <span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;&nbsp;</span>
          <span style="font-weight:bold">R E P U B L I K</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">Y</span>
        </p>
        <p>Nejvyšší správní soud rozhodl v rozšířeném senátě složeném z předsedy
        senátu a soudců v právní věci žalobkyně proti žalovanému o kasační
        stížnosti proti rozsudku městského soudu a po posouzení věci rozhodl.</p>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const titles = documentAst.blocks.filter(
        (block): block is Extract<Block, { type: "heading" }> =>
          block.type === "heading" && block.role === "decision-title",
      );

      expect(titles.map((title) => title.plainText)).toEqual([
        "ROZSUDEK",
        "JMÉNEM REPUBLIKY",
      ]);
      expect(titles.map((title) => title.level)).toEqual([1, 1]);
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
        <p style="text-align:center">
          <span style="font-weight:bold">J M É N E M&nbsp;&nbsp;&nbsp;&nbsp;R E P U B L I K Y</span>
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
        (b) => b.type === "paragraph" && /^\[\d+\]/u.test(b.plainText),
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
      expect(holdings[0]?.plainText).toMatch(/^I\.\s/u);
      expect(holdings[1]?.plainText).toMatch(/^II\.\s/u);
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
      expect(holdings[0]?.plainText).toMatch(/^III\.\s/u);
    });
  });

  describe("unordered list content", () => {
    /**
     * Aspose renders enumerations in the reasoning (case-file
     * inventories, evidence lists) as <ul type="disc">. The chunk
     * walk matched <ol> but not <ul>, so every bullet was dropped
     * from the AST while remaining in the source.
     */
    const bulletHtml = `<html><body>
      <p style="text-align:center">20 A 12/2016</p>
      <p style="text-align:center">
        <span style="font-weight:bold">ROZSUDEK</span>
      </p>
      <p style="text-align:center">
        <span style="font-weight:bold;letter-spacing:3pt">
          t a k t o :
        </span>
      </p>
      <ol type="I">
        <li>Žaloba se zamítá.</li>
      </ol>
      <p style="text-align:center">
        <span style="font-weight:bold">Odůvodnění:</span>
      </p>
      <p>[1] Součástí správního spisu je následující:</p>
      <ul type="disc">
        <li><span style="font-family:Arial">tiskopis „Oznámení
        přestupku"</span></li>
        <li><span style="font-family:Arial">úřední záznam
        vypracovaný policistou</span></li>
      </ul>
      <p>[2] Krajský soud žalobu zamítl.</p>
    </body></html>`;

    test("keeps <ul> bullet text in the AST", () => {
      const { documentAst, fulltext } = parseNssDecisionHtml(
        baseInput(bulletHtml),
      );

      const text = documentAst.blocks
        .map((block) => block.plainText)
        .join("\n");

      expect(text).toContain("tiskopis");
      expect(text).toContain("Oznámení");
      expect(text).toContain("úřední záznam vypracovaný policistou");
      expect(fulltext).toContain("tiskopis");
    });

    test("does not give <ul> items a Roman numeral prefix", () => {
      const { documentAst } = parseNssDecisionHtml(baseInput(bulletHtml));

      const bullet = documentAst.blocks.find((block) =>
        block.plainText.includes("tiskopis"),
      );

      expect(bullet).toBeDefined();
      expect(bullet?.plainText).not.toMatch(/^[IVX]+\.\s/u);
    });

    test("emits a block-wrapped list item exactly once", () => {
      const wrappedHtml = bulletHtml.replace(
        "<p>[2] Krajský soud žalobu zamítl.</p>",
        `<ul type="disc">
          <li><p>zabalená položka</p></li>
        </ul>
        <ol type="I">
          <li><p>zabalený výrok</p></li>
        </ol>
        <p>[2] Krajský soud žalobu zamítl.</p>`,
      );

      const { documentAst, fulltext } = parseNssDecisionHtml(
        baseInput(wrappedHtml),
      );

      const countIn = (needle: string) =>
        documentAst.blocks.filter((block) => block.plainText.includes(needle))
          .length;

      expect(countIn("zabalená položka")).toBe(1);
      expect(countIn("zabalený výrok")).toBe(1);
      expect(fulltext.split("zabalená položka").length - 1).toBe(1);
    });

    test("emits each bullet exactly once when a list is nested", () => {
      const nestedHtml = bulletHtml.replace(
        "<p>[2] Krajský soud žalobu zamítl.</p>",
        `<ul type="disc">
          <li>vnější položka
            <ul type="circle">
              <li>vnitřní položka</li>
            </ul>
          </li>
        </ul>
        <p>[2] Krajský soud žalobu zamítl.</p>`,
      );

      const { documentAst } = parseNssDecisionHtml(baseInput(nestedHtml));

      const occurrences = documentAst.blocks.filter((block) =>
        block.plainText.includes("vnitřní položka"),
      ).length;

      expect(occurrences).toBe(1);
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
          hasBlockInlines(h) &&
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
      expect(para?.plainText).not.toMatch(/^\s{3}/u);
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

  describe("Aspose document structure", () => {
    test("keeps an unnumbered ruling readable and preserves linked footnotes", () => {
      const html = `<html><body>
        <p style="text-align:center">
          <span style="font-weight:bold">ROZSUDEK</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">J M É N E M&nbsp;&nbsp;&nbsp;&nbsp;R E P U B L I K Y</span>
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">t a k t o :</span>
        </p>
        <p>
          Usnesení soudu
          <span style="font-weight:bold">s</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">e</span>
          <span style="font-weight:bold">&nbsp;&nbsp;&nbsp;&nbsp;</span>
          <span style="font-weight:bold">z</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">r</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">u</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">š</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">u</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">j</span>
          <span style="font-weight:bold">&nbsp;</span>
          <span style="font-weight:bold">e</span>.
        </p>
        <p style="text-align:center">
          <span style="font-weight:bold">Odůvodnění:</span>
        </p>
        <p>
          Historický text<a id="_ftnref1" href="#_ftn1">[1]</a> pokračuje.
        </p>
        <hr style="-aw-footnote-type:0" />
        <div id="_ftn1" style="-aw-footnote-isauto:1">
          <p>
            <a href="#_ftnref1">[1]</a>
            <span style="font-style:italic">Poznámka pod čarou.</span>
          </p>
        </div>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(
        baseInput(html, { caseNumber: "4 As 3/2008" }),
      );
      const holding = documentAst.blocks.find(
        (block): block is Extract<Block, { type: "paragraph" }> =>
          block.type === "paragraph" && block.role === "holding",
      );
      const republicTitle = documentAst.blocks.find(
        (block) => block.plainText === "JMÉNEM REPUBLIKY",
      );
      const reference = documentAst.blocks.find((block) =>
        block.plainText.includes("Historický text"),
      );
      const footnote = documentAst.blocks.find(
        (block) =>
          block.type === "paragraph" && block.note?.type === "footnote",
      );

      expect(republicTitle).toMatchObject({
        type: "heading",
        role: "decision-title",
      });
      expect(holding?.plainText).toContain("se zrušuje");
      expect(holding?.inlines).toContainEqual({
        type: "bold",
        children: [{ type: "text", text: "se zrušuje" }],
      });
      expect(
        reference?.type === "paragraph" ? reference.inlines : [],
      ).toContainEqual({
        type: "link",
        href: "#_ftn1",
        children: [{ type: "text", text: "[1]" }],
      });
      expect(footnote).toMatchObject({
        anchorId: "_ftn1",
        note: { type: "footnote", label: "1" },
        plainText: "[1] Poznámka pod čarou.",
      });
    });

    test("keeps inline takto prose and marks its ordered ruling as a holding", () => {
      const html = `<html><body>
        <p>Soud rozhodl takto:</p>
        <ol type="I"><li>Kasační stížnost se zamítá.</li></ol>
        <p>Odůvodnění:</p>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const inlineIntro = documentAst.blocks.find(
        (block) => block.plainText === "Soud rozhodl takto:",
      );
      const holding = documentAst.blocks.find(
        (block) => block.type === "paragraph" && block.role === "holding",
      );

      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        "Soud rozhodl takto:",
      );
      expect(inlineIntro).toMatchObject({ type: "paragraph" });
      expect(holding).toMatchObject({
        plainText: "I. Kasační stížnost se zamítá.",
      });
    });

    test("does not reopen holdings for takto text quoted in reasoning", () => {
      const html = `<html><body>
        <p>Soud rozhodl takto:</p>
        <p>Kasační stížnost se zamítá.</p>
        <p>Odůvodnění:</p>
        <p>Napadený soud rozhodl takto:</p>
        <p>[1] Citované rozhodnutí soud přezkoumal.</p>
        <p>Další část odůvodnění.</p>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const holdings = findAllByRole(documentAst.blocks, "holding");

      expect(holdings.map((holding) => holding.plainText)).toEqual([
        "Kasační stížnost se zamítá.",
      ]);
      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        "Napadený soud rozhodl takto:",
      );
      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        "Citované rozhodnutí soud přezkoumal.",
      );
    });

    test("uses a numbered paragraph to end a holding with no separator", () => {
      const html = `<html><body>
        <p>Soud rozhodl takto:</p>
        <p>Kasační stížnost se zamítá.</p>
        <p>[1] Soud přezkoumal napadené rozhodnutí.</p>
        <p>Další část odůvodnění.</p>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const holdings = findAllByRole(documentAst.blocks, "holding");

      expect(holdings.map((holding) => holding.plainText)).toEqual([
        "Kasační stížnost se zamítá.",
      ]);
      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        "Soud přezkoumal napadené rozhodnutí.",
      );
      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        "Další část odůvodnění.",
      );
    });

    test("groups the paragraphs of one publisher footnote under its container id", () => {
      const html = `<html><body>
        <p>Text<a href="#_ftn1">[1]</a>.</p>
        <div id="_ftn1">
          <p><a href="#_ftnref1">[1]</a> První odstavec.</p>
          <p>Druhý odstavec.</p>
        </div>
        <div id="_ftn2">
          <p><a href="#_ftnref2">[2]</a> Jiná poznámka.</p>
        </div>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const notes = documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" && block.note?.type === "footnote"
          ? [block.note]
          : [],
      );

      expect(notes).toEqual([
        { type: "footnote", label: "1", noteId: "_ftn1" },
        { type: "footnote", label: "1", noteId: "_ftn1" },
        { type: "footnote", label: "2", noteId: "_ftn2" },
      ]);
    });

    test("gives every paragraph in one publisher footnote a unique anchor", () => {
      const html = `<html><body>
        <p>Text<a href="#_ftn1">[1]</a>.</p>
        <div id="_ftn1">
          <p><a href="#_ftnref1">[1]</a> První odstavec.</p>
          <p>Druhý odstavec.</p>
        </div>
      </body></html>`;

      const { documentAst } = parseNssDecisionHtml(baseInput(html));
      const footnotes = documentAst.blocks.filter(
        (block): block is Extract<Block, { type: "paragraph" }> =>
          block.type === "paragraph" && block.note?.type === "footnote",
      );

      expect(footnotes.map((footnote) => footnote.anchorId)).toEqual([
        "_ftn1",
        "_ftn1-2",
      ]);
      expect(new Set(footnotes.map((footnote) => footnote.anchorId)).size).toBe(
        footnotes.length,
      );
    });
  });

  // ── Letter-spaced emphasis ──────────────────────────────

  describe("letter-spaced emphasis", () => {
    const rulingOf = (verdictHtml: string): string => {
      const html = `<html><body><p style="text-align:center">10 A 46/2015 - 66</p>${bold("ROZSUDEK")}${bold("JMÉNEM REPUBLIKY")}<p>Krajský soud v Českých Budějovicích rozhodl v senátě ve věci žalobce proti žalovanému o žalobě proti rozhodnutí žalovaného ze dne 1. 1. 2015,</p><p style="text-align:center"><span style="font-weight:bold;letter-spacing:3pt">t a k t o :</span></p>${verdictHtml}${bold("Odůvodnění:")}<p>[1] Krajský soud přezkoumal napadené rozhodnutí.</p></body></html>`;

      const { documentAst } = parseNssDecisionHtml(
        baseInput(html, { caseNumber: "10 A 46/2015" }),
      );
      // The verdict is whatever follows the "takto:" separator, so the
      // locator stays independent of the sentence under test.
      const taktoIndex = documentAst.blocks.findIndex(
        (block) => block.plainText === "takto:",
      );
      return documentAst.blocks.at(taktoIndex + 1)?.plainText ?? "";
    };

    // The reported defect: KSČB 10 A 46/2015 - 66 rendered
    // "Žaloba sez amítá." because the word gap between two emphasized
    // runs was an Aspose spacer span, which the walker dropped. With the
    // gap gone the run stopped looking letter-spaced, and the fallback
    // collapse re-cut the word boundaries one letter off.
    test("collapses a verdict whose word gaps are Aspose spacer spans", () => {
      const spacer = `<span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;&nbsp;</span>`;
      const verdict = `<p><span style="font-weight:bold">Ž a l o b a</span>${spacer}<span style="font-weight:bold">s e</span>${spacer}<span style="font-weight:bold">z a m í t á .</span></p>`;

      expect(rulingOf(verdict)).toBe("Žaloba se zamítá.");
    });

    test.each([
      [
        "-aw-import:spaces",
        `<span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;&nbsp;</span>`,
      ],
      [
        "-aw-import:ignore",
        `<span style="font-weight:bold; -aw-import:ignore">   </span>`,
      ],
      [
        "display:inline-block",
        `<span style="font-weight:bold; display:inline-block; width:12pt">&nbsp;</span>`,
      ],
      [
        "empty inline-block",
        `<span style="font-weight:bold; display:inline-block; width:12pt"></span>`,
      ],
    ])("treats a %s spacer span as a word boundary", (_style, spacer) => {
      const verdict = `<p><span style="font-weight:bold">Ž a l o b a</span>${spacer}<span style="font-weight:bold">s e</span>${spacer}<span style="font-weight:bold">z a m í t á .</span></p>`;

      expect(rulingOf(verdict)).toBe("Žaloba se zamítá.");
    });

    test("collapses per-letter wrappers separated by a spacer span", () => {
      const verdict = `<p>${perLetterWrappers("Žaloba se zamítá", () => `<span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;</span>`)}<span style="font-weight:bold">.</span></p>`;

      expect(rulingOf(verdict)).toBe("Žaloba se zamítá.");
    });

    // A word gap split across two adjacent inlines: the spacer span
    // lands beside the ordinary letter separator rather than replacing
    // it, so neither node carries the whole boundary on its own.
    test("collapses a word gap split across adjacent inlines", () => {
      const gap = `<span style="font-weight:bold; -aw-import:spaces">&nbsp;</span><span style="font-weight:bold">&nbsp;</span>`;
      const verdict = `<p>${perLetterWrappers("Žaloba se zamítá", () => gap)}<span style="font-weight:bold">.</span></p>`;

      expect(rulingOf(verdict)).toBe("Žaloba se zamítá.");
    });

    // Indentation between two wrappers is source formatting: HTML
    // collapses it, so it must not widen a letter separator into a word
    // boundary.
    test("ignores pretty-printer indentation between wrappers", () => {
      const verdict = `<p>\n  ${perLetterWrappers("Žaloba se zamítá", () => `<span style="font-weight:bold">&nbsp;&nbsp;&nbsp;&nbsp;</span>`).replaceAll("</span><span", "</span>\n  <span")}.\n</p>`;

      expect(rulingOf(verdict)).toBe("Žaloba se zamítá.");
    });

    // Round trip: letter-space a sentence with every gap width the
    // publisher emits, in every markup shape, and require the original
    // sentence back verbatim. The parser may join the letter-spacing and
    // nothing else — the reader never rewrites court text.
    describe("round trip", () => {
      const sentences = [
        "Žaloba se zamítá.",
        "Kasační stížnost se zamítá.",
        "Rozsudek krajského soudu se zrušuje.",
        "Věc se vrací žalovanému k dalšímu řízení.",
        "Žádný z účastníků nemá právo na náhradu nákladů řízení.",
      ] as const;

      const gaps = {
        "two spaces": "  ",
        "three spaces": "   ",
        "two non-breaking spaces": "\u00a0\u00a0",
        "four non-breaking spaces": "\u00a0\u00a0\u00a0\u00a0",
        "mixed space and non-breaking space": " \u00a0",
      } as const;

      for (const sentence of sentences) {
        for (const [gapName, gap] of Object.entries(gaps)) {
          test(`one wrapper, ${gapName}: ${sentence}`, () => {
            const verdict = `<p><span style="font-weight:bold;letter-spacing:3pt">${letterSpace(sentence, gap)}</span></p>`;

            expect(rulingOf(verdict)).toBe(sentence);
          });
        }

        test(`spacer-span gaps: ${sentence}`, () => {
          const spacer = `<span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;&nbsp;</span>`;
          const { body, punctuation } = splitTrailingPunctuation(sentence);
          const verdict = `<p>${body
            .split(" ")
            .map(
              (word) =>
                `<span style="font-weight:bold">${word.split("").join(" ")}</span>`,
            )
            .join(
              spacer,
            )}<span style="font-weight:bold"> ${punctuation}</span></p>`;

          expect(rulingOf(verdict)).toBe(sentence);
        });

        test(`per-letter wrappers: ${sentence}`, () => {
          const { body, punctuation } = splitTrailingPunctuation(sentence);
          const verdict = `<p>${perLetterWrappers(
            body,
            () =>
              `<span style="font-weight:bold; -aw-import:spaces">&nbsp;&nbsp;</span>`,
          )}<span style="font-weight:bold">${punctuation}</span></p>`;

          expect(rulingOf(verdict)).toBe(sentence);
        });
      }
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
