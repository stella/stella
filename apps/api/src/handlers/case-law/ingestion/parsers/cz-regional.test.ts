import { describe, expect, test } from "bun:test";

import type {
  Block,
  ParagraphBlock,
} from "@/api/handlers/case-law/document-ast";
import { parseRegionalDecision } from "@/api/handlers/case-law/ingestion/parsers/cz-regional";
import type { ParseRegionalInput } from "@/api/handlers/case-law/ingestion/parsers/cz-regional";

// ── Helpers ─────────────────────────────────────────────────

const makeStyle = (
  localId: number,
  overrides?: { bold?: boolean; italic?: boolean },
) => ({
  localId,
  alignment: "left",
  hasSpaceBefore: false,
  hasSpaceAfter: false,
  bold: overrides?.bold ?? false,
  italic: overrides?.italic ?? false,
});

const makePara = (text: string, styleId = 1, anonStyle = "NORMAL") => ({
  texts: [{ text, anonStyle }],
  styleLocalId: styleId,
  tableCellInfo: null,
});

const baseInput = (
  overrides?: Partial<ParseRegionalInput>,
): ParseRegionalInput => ({
  caseNumber: "10 C 123/2025",
  ecli: "ECLI:CZ:OSPH:2025:10.C.123.2025.1",
  court: "Obvodní soud pro Prahu 1",
  decisionDate: "2025-01-15",
  decisionType: "rozsudek",
  sourceUrl: "https://rozhodnuti.justice.cz/detail/123",
  header: [],
  verdict: [],
  justification: [],
  information: [],
  styles: [makeStyle(1), makeStyle(2, { bold: true })],
  verdictText: "",
  justificationText: "",
  ...overrides,
});

const collectPlainTexts = (blocks: Block[]): string[] =>
  blocks.map((b) => b.plainText);

const findByRole = (blocks: Block[], role: string) =>
  blocks.find((b) => "role" in b && b.role === role);

const findAllByType = (blocks: Block[], type: string) =>
  blocks.filter((b) => b.type === type);

const isParagraph = (b: Block): b is ParagraphBlock => b.type === "paragraph";

// ── Basic structure ─────────────────────────────────────────

describe("parseRegionalDecision", () => {
  describe("decision title", () => {
    test("synthesizes ROZSUDEK heading from decisionType", () => {
      const input = baseInput({
        header: [makePara("Obvodní soud pro Prahu 1")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title).toBeDefined();
      expect(title?.plainText).toBe("ROZSUDEK");
      expect(title?.type).toBe("heading");
    });

    test("synthesizes USNESENÍ heading", () => {
      const input = baseInput({
        decisionType: "usnesení",
        header: [makePara("Soud")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title?.plainText).toBe("USNESENÍ");
    });

    test("synthesizes PŘÍKAZ heading", () => {
      const input = baseInput({
        decisionType: "příkaz",
        header: [makePara("Soud")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title?.plainText).toBe("PŘÍKAZ");
    });

    test("omits title for unknown decisionType", () => {
      const input = baseInput({
        decisionType: "jiné",
        header: [makePara("Soud")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title).toBeUndefined();
    });

    test("omits title when decisionType is undefined", () => {
      const input = baseInput({
        decisionType: undefined,
        header: [makePara("Soud")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const title = findByRole(documentAst.blocks, "decision-title");
      expect(title).toBeUndefined();
    });
  });

  // ── Section mapping ─────────────────────────────────────

  describe("section mapping", () => {
    test("maps header paragraphs to intro role", () => {
      const input = baseInput({
        header: [
          makePara("Obvodní soud pro Prahu 1"),
          makePara("rozhodl v senátě složeném z..."),
        ],
      });

      const { documentAst } = parseRegionalDecision(input);

      const introBlocks = documentAst.blocks.filter(
        (b) => "role" in b && b.role === "intro",
      );
      expect(introBlocks.length).toBe(2);
    });

    test("adds takto: heading before verdict", () => {
      const input = baseInput({
        verdict: [makePara("Žaloba se zamítá.")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const texts = collectPlainTexts(documentAst.blocks);
      expect(texts).toContain("takto:");
    });

    test("maps verdict paragraphs to holding role", () => {
      const input = baseInput({
        verdict: [
          makePara("I. Žaloba se zamítá."),
          makePara("II. Žádný z účastníků nemá právo na náhradu."),
        ],
      });

      const { documentAst } = parseRegionalDecision(input);

      const holdings = documentAst.blocks.filter(
        (b) => "role" in b && b.role === "holding",
      );
      expect(holdings.length).toBe(2);
    });

    test("adds Odůvodnění: heading before justification", () => {
      const input = baseInput({
        justification: [makePara("Soud provedl dokazování a zjistil...")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const texts = collectPlainTexts(documentAst.blocks);
      expect(texts).toContain("Odůvodnění:");
    });

    test("adds Poučení: heading before information", () => {
      const input = baseInput({
        information: [makePara("Proti tomuto rozsudku lze podat odvolání.")],
      });

      const { documentAst } = parseRegionalDecision(input);

      const texts = collectPlainTexts(documentAst.blocks);
      expect(texts).toContain("Poučení:");
    });
  });

  // ── Full decision structure ───────────────────────────────

  describe("full decision structure", () => {
    test("produces all sections in correct order", () => {
      const input = baseInput({
        header: [
          makePara("Obvodní soud pro Prahu 1"),
          makePara("rozhodl v senátě"),
        ],
        verdict: [makePara("Žaloba se zamítá.")],
        justification: [
          makePara("1. Žalobce podal žalobu dne 1. 1. 2025."),
          makePara("V Praze dne 15. ledna 2025"),
          makePara("JUDr. Jan Novák předseda senátu"),
        ],
        information: [makePara("Proti tomuto rozsudku lze podat odvolání.")],
        verdictText: "Žaloba se zamítá.",
        justificationText:
          "Žalobce podal žalobu dne 1. 1. 2025. " +
          "V Praze dne 15. ledna 2025 " +
          "JUDr. Jan Novák předseda senátu",
      });

      const { documentAst, fulltext } = parseRegionalDecision(input);

      // Verify section order
      const headings = findAllByType(documentAst.blocks, "heading");
      const headingTexts = headings.map((h) => h.plainText);
      expect(headingTexts).toContain("ROZSUDEK");
      expect(headingTexts).toContain("takto:");
      expect(headingTexts).toContain("Odůvodnění:");
      expect(headingTexts).toContain("Poučení:");

      // Verify order: title < takto < oduvodneni < pouceni
      const titleIdx = headingTexts.indexOf("ROZSUDEK");
      const taktoIdx = headingTexts.indexOf("takto:");
      const oduvIdx = headingTexts.indexOf("Odůvodnění:");
      const poucIdx = headingTexts.indexOf("Poučení:");
      expect(titleIdx).toBeLessThan(taktoIdx);
      expect(taktoIdx).toBeLessThan(oduvIdx);
      expect(oduvIdx).toBeLessThan(poucIdx);

      // Fulltext includes all content
      expect(fulltext).toContain("Obvodní soud pro Prahu 1");
      expect(fulltext).toContain("Žaloba se zamítá.");
      expect(fulltext).toContain("Žalobce podal žalobu");
    });
  });

  // ── Inline formatting ─────────────────────────────────────

  describe("inline formatting", () => {
    test("preserves bold styling from style map", () => {
      const input = baseInput({
        styles: [makeStyle(1), makeStyle(2, { bold: true })],
        header: [makePara("Bold text", 2)],
      });

      const { documentAst } = parseRegionalDecision(input);

      const headerBlock = documentAst.blocks
        .filter(isParagraph)
        .find((b) => b.role === "intro");
      expect(headerBlock).toBeDefined();
      const firstInline = headerBlock?.inlines.at(0);
      expect(firstInline?.type).toBe("bold");
    });

    test("preserves italic styling", () => {
      const input = baseInput({
        styles: [makeStyle(1), makeStyle(3, { italic: true })],
        header: [makePara("Italic text", 3)],
      });

      const { documentAst } = parseRegionalDecision(input);

      const headerBlock = documentAst.blocks
        .filter(isParagraph)
        .find((b) => b.role === "intro");
      const firstInline = headerBlock?.inlines.at(0);
      expect(firstInline?.type).toBe("italic");
    });

    test("wraps bold+italic correctly", () => {
      const input = baseInput({
        styles: [makeStyle(1), makeStyle(4, { bold: true, italic: true })],
        header: [makePara("Bold italic", 4)],
      });

      const { documentAst } = parseRegionalDecision(input);

      const headerBlock = documentAst.blocks
        .filter(isParagraph)
        .find((b) => b.role === "intro");
      const firstInline = headerBlock?.inlines.at(0);
      expect(firstInline?.type).toBe("bold");
      if (firstInline?.type === "bold") {
        expect(firstInline.children.at(0)?.type).toBe("italic");
      }
    });

    test("preserves anonymized spans", () => {
      const input = baseInput({
        header: [
          {
            texts: [
              { text: "Žalobce ", anonStyle: "NORMAL" },
              { text: "J. N.", anonStyle: "ANON" },
              { text: " podal žalobu.", anonStyle: "NORMAL" },
            ],
            styleLocalId: 1,
            tableCellInfo: null,
          },
        ],
      });

      const { documentAst } = parseRegionalDecision(input);

      const intro = documentAst.blocks
        .filter(isParagraph)
        .find((b) => b.role === "intro");
      expect(intro).toBeDefined();
      const anonInline = intro?.inlines.find(
        (i) => i.type === "text" && i.anonymized === true,
      );
      expect(anonInline).toBeDefined();
      if (anonInline?.type === "text") {
        expect(anonInline.text).toBe("J. N.");
      }
    });
  });

  // ── Justification classification ──────────────────────────

  describe("justification paragraph classification", () => {
    test("strips numbered prefix from paragraphs", () => {
      const input = baseInput({
        justification: [makePara("1. Žalobce podal žalobu dne 1. 1. 2025.")],
        justificationText: "Žalobce podal žalobu dne 1. 1. 2025.",
      });

      const { documentAst } = parseRegionalDecision(input);

      // Find the justification paragraph (not the heading)
      const justBlocks = documentAst.blocks.filter(
        (b) => b.type === "paragraph" && !("role" in b && b.role),
      );
      // Should strip "1. " prefix
      const stripped = justBlocks.find((b) =>
        b.plainText.startsWith("Žalobce"),
      );
      expect(stripped).toBeDefined();
    });

    test("classifies closing formula", () => {
      const input = baseInput({
        justification: [makePara("V Praze dne 15. ledna 2025")],
        justificationText: "V Praze dne 15. ledna 2025",
      });

      const { documentAst } = parseRegionalDecision(input);

      const closing = findByRole(documentAst.blocks, "closing");
      expect(closing).toBeDefined();
      expect(closing?.plainText).toContain("V Praze dne");
    });

    test("classifies signature line", () => {
      const input = baseInput({
        justification: [makePara("JUDr. Jan Novák předseda senátu")],
        justificationText: "JUDr. Jan Novák předseda senátu",
      });

      const { documentAst } = parseRegionalDecision(input);

      const sig = findByRole(documentAst.blocks, "signature");
      expect(sig).toBeDefined();
      expect(sig?.plainText).toContain("předseda senátu");
    });

    test("classifies samosoudce signature", () => {
      const input = baseInput({
        justification: [makePara("Mgr. Jana Nová samosoudkyně")],
        justificationText: "Mgr. Jana Nová samosoudkyně",
      });

      const { documentAst } = parseRegionalDecision(input);

      const sig = findByRole(documentAst.blocks, "signature");
      expect(sig).toBeDefined();
    });

    test("does not classify long text as signature", () => {
      const longText =
        "Soudce zpravodaj konstatoval, že žalobce podal " +
        "žalobu řádně a včas, přičemž žalovaný se k žalobě " +
        "nevyjádřil ve lhůtě stanovené soudem.";
      const input = baseInput({
        justification: [makePara(longText)],
        justificationText: longText,
      });

      const { documentAst } = parseRegionalDecision(input);

      const sig = findByRole(documentAst.blocks, "signature");
      expect(sig).toBeUndefined();
    });
  });

  // ── Edge cases ────────────────────────────────────────────

  describe("edge cases", () => {
    test("skips empty paragraphs", () => {
      const input = baseInput({
        header: [
          makePara("Text"),
          makePara(""),
          makePara("   "),
          makePara("More text"),
        ],
      });

      const { documentAst } = parseRegionalDecision(input);

      const introBlocks = documentAst.blocks.filter(
        (b) => "role" in b && b.role === "intro",
      );
      expect(introBlocks.length).toBe(2);
    });

    test("handles empty sections", () => {
      const input = baseInput({
        header: [],
        verdict: [],
        justification: [],
        information: [],
      });

      const { documentAst } = parseRegionalDecision(input);

      // Only the title heading (ROZSUDEK)
      expect(documentAst.blocks.length).toBe(1);
    });

    test("handles multiple spans in a paragraph", () => {
      const input = baseInput({
        header: [
          {
            texts: [
              { text: "Obvodní soud ", anonStyle: "NORMAL" },
              { text: "pro Prahu 1", anonStyle: "NORMAL" },
            ],
            styleLocalId: 1,
            tableCellInfo: null,
          },
        ],
      });

      const { documentAst } = parseRegionalDecision(input);

      const intro = findByRole(documentAst.blocks, "intro");
      expect(intro?.plainText).toBe("Obvodní soud pro Prahu 1");
    });

    test("handles currency amounts in text", () => {
      const input = baseInput({
        verdict: [
          makePara(
            "Žalovaný je povinen zaplatit žalobci " +
              "částku 150 000 Kč s příslušenstvím.",
          ),
        ],
        verdictText:
          "Žalovaný je povinen zaplatit žalobci " +
          "částku 150 000 Kč s příslušenstvím.",
      });

      const { documentAst } = parseRegionalDecision(input);

      const holding = findByRole(documentAst.blocks, "holding");
      expect(holding?.plainText).toContain("150 000 Kč");
    });
  });

  // ── Metadata ──────────────────────────────────────────────

  describe("metadata", () => {
    test("populates DocumentAst metadata", () => {
      const input = baseInput();

      const { documentAst } = parseRegionalDecision(input);

      expect(documentAst.version).toBe(1);
      expect(documentAst.source.system).toBe("justice.cz");
      expect(documentAst.source.documentId).toBe("10 C 123/2025");
      expect(documentAst.metadata.caseNumber).toBe("10 C 123/2025");
      expect(documentAst.metadata.ecli).toBe(
        "ECLI:CZ:OSPH:2025:10.C.123.2025.1",
      );
      expect(documentAst.metadata.court).toBe("Obvodní soud pro Prahu 1");
      expect(documentAst.metadata.decisionDate).toBe("2025-01-15");
      expect(documentAst.metadata.decisionType).toBe("rozsudek");
    });

    test("handles null optional metadata", () => {
      const input = baseInput({
        ecli: undefined,
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: undefined,
      });

      const { documentAst } = parseRegionalDecision(input);

      expect(documentAst.metadata.ecli).toBeNull();
      expect(documentAst.metadata.decisionDate).toBeNull();
      expect(documentAst.metadata.decisionType).toBeNull();
      expect(documentAst.source.webUrl).toBe("");
    });
  });

  // ── Fulltext generation ───────────────────────────────────

  describe("fulltext", () => {
    test("joins all block plainTexts with double newlines", () => {
      const input = baseInput({
        header: [makePara("Header text")],
        verdict: [makePara("Verdict text")],
      });

      const { fulltext } = parseRegionalDecision(input);

      expect(fulltext).toContain("Header text");
      expect(fulltext).toContain("Verdict text");
      expect(fulltext).toContain("ROZSUDEK");
    });
  });
});
