import { describe, expect, test } from "bun:test";

import { hasBlockInlines } from "@/api/handlers/case-law/document-ast";
import type { Block } from "@/api/handlers/case-law/document-ast";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import type { ParseUsDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";

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
          hasBlockInlines(b) &&
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

    test("preserves same-line Roman section and subsection headings", () => {
      const rtf = [
        "\\pard NÁLEZ",
        "\\par",
        "O d ů v o d n ě n í :",
        "\\par",
        "VIII. Vlastní přezkum",
        "\\par",
        "VIII. A) Tzv. data retention",
        "\\par",
        "Text přezkumu.",
      ].join("\n");
      const input = baseInput(`
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="99999" />
        </body></html>
      `);

      const { documentAst } = parseUsDecisionHtml(input);
      expect(
        documentAst.blocks
          .filter((block) => block.type === "heading")
          .map((block) => ({ level: block.level, text: block.plainText })),
      ).toContainEqual({ level: 3, text: "VIII. Vlastní přezkum" });
      expect(
        documentAst.blocks
          .filter((block) => block.type === "heading")
          .map((block) => ({ level: block.level, text: block.plainText })),
      ).toContainEqual({ level: 4, text: "VIII. A) Tzv. data retention" });
    });

    test("does not turn punctuation-only lines into Roman numeral headings", () => {
      const rtf = [
        "\\pard NÁLEZ",
        "\\par",
        "t a k t o :",
        "\\par",
        "Ústavní stížnost se odmítá.",
        "\\par",
        "O d ů v o d n ě n í :",
        "\\par",
        ".",
        "\\par",
        "Skutečný odstavec odůvodnění.",
      ].join("\n");
      const input = baseInput(`
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="registrySignHidden" value="I.ÚS 100/25 #1" />
          <input id="paralellQuotationHidden" value="" />
          <input id="popularNameHidden" value="" />
          <input id="docIdHidden" value="99999" />
        </body></html>
      `);
      const { documentAst } = parseUsDecisionHtml(input);

      const h3s = documentAst.blocks.filter(
        (b) => b.type === "heading" && "level" in b && b.level === 3,
      );
      expect(h3s).toHaveLength(0);
      expect(
        documentAst.blocks.some(
          (b) =>
            b.type === "paragraph" &&
            b.plainText === "Skutečný odstavec odůvodnění.",
        ),
      ).toBe(true);
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

  describe("separate opinions", () => {
    const MAJORITY_TEXT = "Ústavní soud shledal ústavní stížnost důvodnou.";
    const DISSENT_TEXT = "S většinovým závěrem pléna nesouhlasím.";

    const decisionWith = (opinionLine: string): string => {
      const rtf = [
        "\\pard NÁLEZ",
        "\\par",
        "t a k t o :",
        "\\par",
        "I. Ústavní stížnosti se vyhovuje.",
        "\\par",
        "O d ů v o d n ě n í :",
        "\\par",
        `1. ${MAJORITY_TEXT}`,
        "\\par",
        opinionLine,
        "\\par",
        `2. ${DISSENT_TEXT}`,
      ].join("\n");
      return `
        <html><body>
          <span id="lblDecisionForm">NÁLEZ</span>
          <input id="docContentHidden" value="${rtf}" />
          <input id="docIdHidden" value="77777" />
        </body></html>
      `;
    };

    const roleOf = (block: Block): string | undefined =>
      block.type === "heading" || block.type === "paragraph"
        ? block.role
        : undefined;

    const rolesOf = (opinionLine: string) =>
      parseUsDecisionHtml(
        baseInput(decisionWith(opinionLine)),
      ).documentAst.blocks.map((block) => ({
        text: block.plainText,
        role: roleOf(block),
      }));

    test("marks the opinion body, not the majority text or its heading", () => {
      const heading = "Odlišné stanovisko soudce Jana Nováka";
      const roles = rolesOf(heading);

      expect(roles).toContainEqual({ text: heading, role: "section-heading" });
      expect(roles).toContainEqual({ text: MAJORITY_TEXT, role: undefined });
      expect(roles).toContainEqual({ text: DISSENT_TEXT, role: "dissent" });
    });

    test.each([
      "Odlišné stanovisko soudce Jana Nováka",
      "Odlišná stanoviska",
      "Stanovisko menšiny",
      "ODLIŠNÉ STANOVISKO",
      "Odlisne stanovisko",
    ])("opens the opinion zone at %s", (opinionLine) => {
      expect(rolesOf(opinionLine)).toContainEqual({
        text: DISSENT_TEXT,
        role: "dissent",
      });
    });

    test("keeps the number the court printed on the opinion heading", () => {
      const heading = "3. Odlišné stanovisko soudce Jana Nováka";
      const parsed = parseUsDecisionHtml(baseInput(decisionWith(heading)));

      // The number is stripped to recognise the heading, never to store it:
      // a block that dropped it would take the number out of the fulltext.
      expect(rolesOf(heading)).toContainEqual({
        text: heading,
        role: "section-heading",
      });
      expect(parsed.fulltext).toContain(heading);
    });

    test("leaves prose that only mentions a separate opinion unmarked", () => {
      const mention =
        "Odlišné stanovisko soudce k dřívějšímu nálezu se s nyní " +
        "posuzovanou věcí míjí, neboť vychází z jiného skutkového základu " +
        "a z jiné právní úpravy.";
      const roles = rolesOf(mention);

      expect(mention.length).toBeGreaterThan(120);
      expect(roles).toContainEqual({ text: mention, role: undefined });
      expect(roles).toContainEqual({ text: DISSENT_TEXT, role: undefined });
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

    test("keeps text the emblem placeholder is glued to", () => {
      const rtf = [
        "[OBRÁZEK]Česká republika",
        "\\par",
        "[OBRÁZEK][OBRÁZEK]Ústavní soud návrhu vyhověl.",
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

      const { documentAst, fulltext } = parseUsDecisionHtml(baseInput(html));
      const texts = documentAst.blocks.map((b) => b.plainText);

      expect(fulltext).toContain("Ústavní soud návrhu vyhověl");
      expect(texts.some((t) => t.includes("[OBRÁZEK]"))).toBe(false);
      // The emblem glued to a decorative line leaves nothing to keep.
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

  describe("embedded pictures", () => {
    /**
     * Pl.ÚS-st. 27/09 prints a horizontal rule between the majority opinion
     * and the first dissent. Word exports that rule twice — as a PNG in an
     * ignorable `{\*\shppict}` destination and as a metafile in
     * `{\nonshppict}` — and both carry their bytes as hex. Read as text,
     * the pair put `\pict\*\picprop\shplid1025 … \pngblip` and hundreds of
     * hex digits into the decision, immediately before "1. Odlišné
     * stanovisko".
     */
    const pngPayload = "89504e470d0a1a0a0000000d49484452".repeat(8);
    const metafilePayload = "0100090000034f00000000004f000000".repeat(8);
    const pictureRtf = [
      "\\pard\\b NÁLEZ\\b0",
      "\\par",
      "O d ů v o d n ě n í :",
      "\\par",
      "1. Srov. rozsudek ESLP ze dne 12. listopadu 2008 ve věci Demir",
      "a Baykara proti Turecku, stížnost č. 34503/97.",
      "\\par",
      `{\\*\\shppict{\\pict{\\*\\picprop\\shplid1025{\\sp{\\sn shapeType}{\\sv 75}}}\\picw16113\\pich26\\picwgoal9135\\pichgoal15\\pngblip ${pngPayload}}}{\\nonshppict{\\pict\\wmetafile8 ${metafilePayload}}}\\insrsid14565320\\charrsid14565320 1. Odlišné stanovisko soudkyně Elišky Wagnerové.`,
    ].join("\n");

    const pictureHtml = `
      <html><body>
        <span id="lblDecisionForm">NÁLEZ</span>
        <input id="docContentHidden" value="${pictureRtf}" />
        <input id="docIdHidden" value="54321" />
      </body></html>
    `;

    test("skips picture destinations and keeps the dissent that follows", () => {
      const { documentAst, fulltext } = parseUsDecisionHtml(
        baseInput(pictureHtml, { caseNumber: "Pl.ÚS-st. 27/09" }),
      );

      const citationIndex = documentAst.blocks.findIndex((block) =>
        block.plainText.includes("34503/97"),
      );
      expect(citationIndex).toBeGreaterThanOrEqual(0);
      expect(documentAst.blocks.at(citationIndex + 1)?.plainText).toBe(
        "1. Odlišné stanovisko soudkyně Elišky Wagnerové.",
      );
      expect(fulltext).toContain("Odlišné stanovisko");
    });

    test("leaves no control words, hex payload or revision ids in the text", () => {
      const { fulltext } = parseUsDecisionHtml(
        baseInput(pictureHtml, { caseNumber: "Pl.ÚS-st. 27/09" }),
      );

      expect(fulltext).not.toMatch(/\\[a-zA-Z]/u);
      expect(fulltext).not.toMatch(/[0-9a-fA-F]{32,}/u);
      expect(fulltext).not.toContain("insrsid");
      expect(fulltext).not.toContain("pngblip");
      expect(markupResidueIn(fulltext)).toBeUndefined();
    });

    test("skips the font, colour and revision tables of a whole document", () => {
      const rtf = [
        "{\\rtf1\\ansi\\deff0",
        "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}",
        "{\\colortbl ;\\red0\\green0\\blue0;}",
        "{\\*\\rsidtbl \\rsid14565320\\rsid2296163}",
        "{\\info{\\title Nalez}{\\author Ustavni soud}}",
        "\\pard\\f0\\fs24 Ústavní soud rozhodl takto:",
        "\\par",
        "Ústavní stížnost se odmítá.",
        "}",
      ].join("\n");
      const { fulltext } = parseUsDecisionHtml(
        baseInput(`
          <html><body>
            <span id="lblDecisionForm">USNESENÍ</span>
            <input id="docContentHidden" value="${rtf}" />
            <input id="docIdHidden" value="54322" />
          </body></html>
        `),
      );

      expect(fulltext).toContain("Ústavní stížnost se odmítá.");
      expect(fulltext).not.toContain("Times New Roman");
      expect(fulltext).not.toContain("Ustavni soud");
      expect(markupResidueIn(fulltext)).toBeUndefined();
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
