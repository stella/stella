import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@/api/handlers/case-law/document-ast";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";

const baseInput = (
  content: string,
  overrides?: Partial<Parameters<typeof parsePlDecisionContent>[0]>,
): Parameters<typeof parsePlDecisionContent>[0] => ({
  caseNumber: "I ACa 772/13",
  ecli: "ECLI:PL:SAOS:2013:1",
  court: "Sąd Apelacyjny w Łodzi",
  decisionDate: "2013-12-04",
  decisionType: "wyrok",
  sourceUrl: "https://www.saos.org.pl/judgments/31345",
  documentUrl: "https://orzeczenia.ms.gov.pl/example",
  content,
  keywords: ["dobra osobiste", "zadośćuczynienie"],
  statutes: ["art. 24 k.c."],
  documentId: "152500000000503_I_ACa_000772_2013_Uz_2013-12-04_001",
  ...overrides,
});

const findByRole = (blocks: Block[], role: string) =>
  blocks.find((block) => "role" in block && block.role === role);

const flattenInlineText = (inlines: Inline[]): string =>
  inlines
    .map((inline) => {
      if (inline.type === "text") {
        return inline.text;
      }

      if (inline.type === "line-break") {
        return "\n";
      }

      return flattenInlineText(inline.children);
    })
    .join("");

describe("parsePlDecisionContent", () => {
  test("parses SAOS HTML into headings, holdings, and argumentation", () => {
    const html = `
      <p><strong>Sygn. akt I ACa 772/13</strong></p>
      <div>
        <h2>WYROK</h2>
        <h5>W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ</h5>
        <p>Dnia 4 grudnia 2013 roku</p>
        <p>Sąd Apelacyjny w Łodzi I Wydział Cywilny w składzie:</p>
        <p><strong>I) oddala apelację pozwanego;</strong></p>
        <p><strong>II) zasądza od pozwanego na rzecz <span class="anon-block">P. S.</span> kwotę 10.000 zł.</strong></p>
      </div>
      <div>
        <h2>UZASADNIENIE</h2>
        <p>Powód powołał się na <a href="http://isap.sejm.gov.pl">art. 24 k.c.</a>.</p>
        <p>Warszawa, dnia 4 grudnia 2013 r.</p>
        <p>SSA Jan Kowalski</p>
      </div>
    `;

    const { documentAst, fulltext } = parsePlDecisionContent(baseInput(html));

    const decisionTitles = documentAst.blocks.filter(
      (block) => block.type === "heading" && block.role === "decision-title",
    );
    expect(decisionTitles).toHaveLength(1);

    expect(findByRole(documentAst.blocks, "decision-title")?.plainText).toBe(
      "WYROK",
    );
    expect(findByRole(documentAst.blocks, "case-number")?.plainText).toContain(
      "Sygn. akt I ACa 772/13",
    );

    const holdings = documentAst.blocks.filter(
      (block) => "role" in block && block.role === "holding",
    );
    expect(holdings).toHaveLength(2);
    expect(
      holdings.some((block) => block.plainText.includes("oddala apelację")),
    ).toBe(true);

    const reasonsHeading = documentAst.blocks.find(
      (block) => block.type === "heading" && block.plainText === "UZASADNIENIE",
    );
    expect(reasonsHeading).toBeDefined();

    const argumentation = documentAst.blocks.filter(
      (block) => "role" in block && block.role === "argumentation",
    );
    expect(
      argumentation.some((block) => block.plainText.includes("art. 24 k.c.")),
    ).toBe(true);

    const anonymizedHolding = holdings.find((block) =>
      block.plainText.includes("P. S."),
    );
    const anonymizedText =
      anonymizedHolding?.type === "paragraph"
        ? anonymizedHolding.inlines.find(
            (inline) =>
              inline.type === "bold" &&
              inline.children.some(
                (child) => child.type === "text" && child.anonymized === true,
              ),
          )
        : undefined;
    expect(anonymizedText).toBeDefined();

    const linkedParagraph = argumentation.find((block) =>
      block.plainText.includes("art. 24 k.c."),
    );
    expect(linkedParagraph?.type).toBe("paragraph");
    if (linkedParagraph?.type === "paragraph") {
      expect(
        linkedParagraph.inlines.some(
          (inline) =>
            inline.type === "link" &&
            inline.href === "http://isap.sejm.gov.pl" &&
            flattenInlineText(inline.children).includes("art. 24 k.c."),
        ),
      ).toBe(true);
    }

    expect(findByRole(documentAst.blocks, "closing")?.plainText).toContain(
      "Warszawa, dnia 4 grudnia 2013 r.",
    );
    expect(findByRole(documentAst.blocks, "signature")?.plainText).toContain(
      "SSA Jan Kowalski",
    );
    expect(fulltext).toContain("zasądza od pozwanego");
  });

  test("falls back to plaintext parsing for legacy decisions", () => {
    const content = [
      "Postanowienie",
      "z dnia 3 grudnia 1986 r.",
      "",
      "Sygn. akt U 4/86",
      "",
      "Trybunał Konstytucyjny w składzie:",
      "",
      "I. umorzyć postępowanie w sprawie.",
      "",
      "Uzasadnienie",
      "",
      "Wniosek stał się bezprzedmiotowy.",
    ].join("\n");

    const { documentAst, fulltext } = parsePlDecisionContent(
      baseInput(content, {
        decisionType: "postanowienie",
        court: "Trybunał Konstytucyjny",
      }),
    );

    const decisionTitles = documentAst.blocks.filter(
      (block) => block.type === "heading" && block.role === "decision-title",
    );
    expect(decisionTitles).toHaveLength(1);

    expect(findByRole(documentAst.blocks, "decision-title")?.plainText).toBe(
      "POSTANOWIENIE",
    );
    expect(findByRole(documentAst.blocks, "case-number")?.plainText).toBe(
      "Sygn. akt U 4/86",
    );

    const holdings = documentAst.blocks.filter(
      (block) => "role" in block && block.role === "holding",
    );
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.plainText).toContain("umorzyć postępowanie");

    const reasons = documentAst.blocks.filter(
      (block) => "role" in block && block.role === "argumentation",
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.plainText).toContain("bezprzedmiotowy");
    expect(fulltext).toContain("Trybunał Konstytucyjny");
  });

  test("normalizes tab-heavy legacy plaintext into stable blocks", () => {
    const content = [
      "Wyrok",
      "",
      "Sędziowie TK:\t\tCzesław Bakalarski - sprawozdawca",
      "\t\t\t\tAdam Józefowicz",
      "\t\t\t\tAndrzej Kabat",
      "",
      "orzeka:",
      "",
      "I. przepis jest zgodny z ustawą.",
    ].join("\n");

    const { documentAst, fulltext } = parsePlDecisionContent(
      baseInput(content),
    );

    const intro = documentAst.blocks.find(
      (block) =>
        block.type === "paragraph" &&
        "role" in block &&
        block.role === "intro" &&
        block.plainText.includes("Sędziowie TK:"),
    );

    expect(intro?.plainText).toBe(
      "Sędziowie TK: Czesław Bakalarski - sprawozdawca\nAdam Józefowicz\nAndrzej Kabat",
    );
    expect(fulltext).not.toContain("\t");
  });

  test("preserves spaces across adjacent formatted inline nodes", () => {
    const content =
      "<p><strong>Przewodniczący </strong><em>SSA Jan Kowalski</em></p>";

    const { documentAst } = parsePlDecisionContent(baseInput(content));

    const intro = documentAst.blocks.find(
      (block) => block.type === "paragraph" && block.plainText.includes("SSA"),
    );

    expect(intro?.plainText).toBe("Przewodniczący SSA Jan Kowalski");
  });
});
