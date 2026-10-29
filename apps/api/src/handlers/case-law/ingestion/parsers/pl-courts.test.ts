import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as cheerio from "cheerio";
import { isTag } from "domhandler";

import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import type { Block, Inline } from "@stll/legal-ast/document-ast";

import {
  PL_KIO_HTML_BUDGET,
  PlKioHtmlBudgetError,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio-response-budget";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

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

const roleOfBlock = (block: Block) =>
  "role" in block ? block.role : undefined;

const flattenInlineText = (inlines: Inline[]): string =>
  inlines
    .map((inline) => {
      if (inline.type === "text") {
        return inline.text;
      }

      if (inline.type === "line-break") {
        return "\n";
      }

      return hasInlineChildren(inline)
        ? flattenInlineText(inline.children)
        : "";
    })
    .join("");

describe("parsePlDecisionContent", () => {
  test("keeps a Polish court's printed order and assigns roles from its text", () => {
    const content = `
      <p><strong>II CSKP 1456/22</strong></p>
      <p><strong>WYROK</strong></p>
      <p><strong>W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ</strong></p>
      <p>9 maja 2024 r. Sąd Najwyższy w Izbie Cywilnej w składzie:</p>
      <p><strong>SSN Dariusz Dończyk (przewodniczący)</strong></p>
      <p><strong>SSN Marta Romańska (sprawozdawca)</strong></p>
      <p><strong>SSN Monika Koba</strong></p>
      <p><strong>po rozpoznaniu skargi kasacyjnej.</strong></p>
      <p><strong>1) oddala skargę kasacyjną;</strong></p>
      <p>A.W.</p>
      <p>[ms]</p>
      <p>Monika Koba Dariusz Dończyk Marta Romańska [SOP]</p>
    `;
    const { documentAst } = parsePlDecisionContent(
      baseInput(content, { caseNumber: "II CSKP 1456/22" }),
    );
    const blocks = documentAst.blocks;

    expect(
      blocks.slice(0, 8).map((block) => [block.plainText, roleOfBlock(block)]),
    ).toEqual([
      ["II CSKP 1456/22", "case-number"],
      ["WYROK", "decision-title"],
      ["W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ", "intro"],
      ["9 maja 2024 r. Sąd Najwyższy w Izbie Cywilnej w składzie:", "intro"],
      ["SSN Dariusz Dończyk (przewodniczący)", "panel"],
      ["SSN Marta Romańska (sprawozdawca)", "panel"],
      ["SSN Monika Koba", "panel"],
      ["po rozpoznaniu skargi kasacyjnej.", "intro"],
    ]);
    expect(blocks.at(8)).toMatchObject({ role: "holding" });
    expect(blocks.slice(9).map(roleOfBlock)).toEqual([
      "apparatus",
      "apparatus",
      "signature",
    ]);
  });

  test.each(["", "<p>UZASADNIENIE</p><p>Treść uzasadnienia.</p>"])(
    "uses an inferred decision title only when the source has none: %s",
    (reasons) => {
      const { documentAst } = parsePlDecisionContent(
        baseInput(
          `<p>II CSKP 1456/22</p><p>W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ</p>${reasons}`,
          { caseNumber: "II CSKP 1456/22" },
        ),
      );

      expect(
        documentAst.blocks
          .slice(0, 3)
          .map((block) => [block.plainText, roleOfBlock(block)]),
      ).toEqual([
        ["WYROK", "decision-title"],
        ["II CSKP 1456/22", "case-number"],
        ["W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ", "intro"],
      ]);
    },
  );

  test.each([
    "oddala powództwo",
    "uchylić zaskarżony wyrok",
    "odmawia przyjęcia skargi kasacyjnej",
  ])("uses generated operative forms for unnumbered clauses: %s", (text) => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(`<p>${text}</p>`, { decisionType: undefined }),
    );
    expect(documentAst.blocks.at(0)).toMatchObject({ role: "holding" });
  });

  test("numbered infinitive rulings follow a decision title independently of the verb lexicon", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "<p>POSTANOWIENIE</p><p>1. uchylić zaskarżone postanowienie.</p><p>2. zasądzić koszty.</p>",
        { decisionType: "postanowienie" },
      ),
    );
    expect(
      documentAst.blocks.map((block) => [block.plainText, roleOfBlock(block)]),
    ).toEqual([
      ["POSTANOWIENIE", "decision-title"],
      ["1. uchylić zaskarżone postanowienie.", "holding"],
      ["2. zasądzić koszty.", "holding"],
    ]);
  });

  test.each([
    {
      name: "finite numbered points",
      items: "<p>1) oddala apelację.</p><p>2) zasądza koszty.</p>",
    },
    {
      name: "lettered points outside the lexicon",
      items:
        "<p>a) zobowiązać pozwaną do zapłaty.</p><p>b) ustanowić kuratora.</p>",
    },
    {
      name: "HTML counters outside the lexicon",
      items:
        "<ol><li>zobowiązać pozwaną do zapłaty.</li><li>ustanowić kuratora.</li></ol>",
    },
  ])("the recital opens $name before the reasons", ({ items }) => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        `<p>WYROK</p><p>po rozpoznaniu sprawy o zapłatę,</p>${items}<h2>UZASADNIENIE</h2><p>1. Ustalenia faktyczne.</p>`,
      ),
    );
    expect(
      documentAst.blocks.filter((block) => roleOfBlock(block) === "holding"),
    ).toHaveLength(2);
    expect(documentAst.blocks.at(1)).toMatchObject({ role: "intro" });
    expect(documentAst.blocks.at(-1)).toMatchObject({ role: "argumentation" });
  });

  test("plain-text numbered rulings use the same structural region", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "POSTANOWIENIE\n\npo rozpoznaniu sprawy,\n\n1. zobowiązać pozwaną do zapłaty.\n\n2. ustanowić kuratora.\n\nUZASADNIENIE\n\n1. Ustalenia faktyczne.",
        { decisionType: "postanowienie" },
      ),
    );
    expect(
      documentAst.blocks.filter((block) => roleOfBlock(block) === "holding"),
    ).toHaveLength(2);
    expect(documentAst.blocks.at(-1)).toMatchObject({ role: "argumentation" });
  });

  test("a numeric decision date after the title is opening matter", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "<p>WYROK</p><p>09.05.2024 r.</p><p>po rozpoznaniu sprawy,</p><p>1. uchylić postanowienie.</p>",
      ),
    );
    expect(documentAst.blocks.at(1)).toMatchObject({
      role: "intro",
      plainText: "09.05.2024 r.",
    });
    expect(documentAst.blocks.at(-1)).toMatchObject({ role: "holding" });
  });

  test("numbered bench members remain panel before the operative part", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "<p>POSTANOWIENIE</p><p>Sąd Najwyższy w składzie:</p><p>1. SSN Anna Nowak</p><p>po rozpoznaniu sprawy,</p><p>1. uchylić postanowienie.</p><p>Anna Nowak</p>",
        { decisionType: "postanowienie" },
      ),
    );
    expect(documentAst.blocks.at(2)).toMatchObject({ role: "panel" });
    expect(documentAst.blocks.at(4)).toMatchObject({ role: "holding" });
    expect(documentAst.blocks.at(-1)).toMatchObject({ role: "signature" });
  });

  test("a quoted ruling marker in the reasons does not reopen the operative part", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "<p>WYROK</p><p>oddala apelację.</p><h2>UZASADNIENIE</h2><p>postanawia:</p><p>1. uchylić wcześniejsze postanowienie.</p>",
      ),
    );
    expect(documentAst.blocks.slice(-2).map(roleOfBlock)).toEqual([
      "argumentation",
      "argumentation",
    ]);
  });

  test("does not classify a party's account of an operative verb as holding", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput("<p>Powód twierdzi, że sąd oddala apelację.</p>", {
        decisionType: undefined,
      }),
    );

    expect(documentAst.blocks.at(0)).toMatchObject({ role: "intro" });
  });

  test.each(["postanowił", "uchwalił:"])(
    "opens the holding section at a printed %s heading",
    (heading) => {
      const { documentAst } = parsePlDecisionContent(
        baseInput(`<p>${heading}</p><p>1. oddalić skargę.</p>`, {
          decisionType: undefined,
        }),
      );

      expect(documentAst.blocks).toMatchObject([
        { type: "heading", role: "section-heading", plainText: heading },
        { type: "paragraph", role: "holding", plainText: "1. oddalić skargę." },
      ]);
    },
  );

  test.each(["SSN Anna Nowak", "Anna Nowak (ławnik Sądu Najwyższego)"])(
    "recognizes an individual signature by an already read panel member: %s",
    (member) => {
      const { documentAst } = parsePlDecisionContent(
        baseInput(`<p>${member}</p><p>Uzasadnienie</p><p>Anna Nowak</p>`, {
          decisionType: undefined,
        }),
      );

      expect(documentAst.blocks.at(-1)).toMatchObject({
        plainText: "Anna Nowak",
        role: "signature",
      });
    },
  );

  test.each(["[J.J.]", "[a.ł]", "[ms]"])(
    "keeps a terminal clerk mark out of the operative part: %s",
    (mark) => {
      const { documentAst } = parsePlDecisionContent(
        baseInput(
          `<p>POSTANOWIENIE</p><p>1) oddala skargę.</p><p>${mark}</p>`,
          {
            decisionType: undefined,
          },
        ),
      );
      expect(documentAst.blocks.at(1)).toMatchObject({ role: "holding" });
      expect(documentAst.blocks.at(-1)).toMatchObject({ role: "apparatus" });
    },
  );

  test.each([
    { mark: "[A]", after: "" },
    { mark: "[J.J.]", after: "<p>Dalsze ustalenia.</p>" },
  ])(
    "retains a party marker or a nonterminal initials block in reasoning: $mark",
    ({ mark, after }) => {
      const { documentAst } = parsePlDecisionContent(
        baseInput(`<p>UZASADNIENIE</p><p>${mark}</p>${after}`),
      );
      expect(
        documentAst.blocks.find((block) => block.plainText === mark),
      ).toMatchObject({
        role: "argumentation",
      });
    },
  );

  test("preserves reasoning when the supplied decision type is uzasadnienie", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput("<p>Treść uzasadnienia.</p>", {
        decisionType: "uzasadnienie",
      }),
    );

    expect(documentAst.blocks).toMatchObject([
      { type: "heading", role: "decision-title", plainText: "UZASADNIENIE" },
      {
        type: "paragraph",
        role: "argumentation",
        plainText: "Treść uzasadnienia.",
      },
    ]);
  });

  test("reads UOKiK decision basis points in the supplied decision section", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        `<p>RGD.430.13.2022</p><p>DECYZJA NR RGD-16/2024</p><p>I. Na podstawie art. 106 ustawy...</p><p>― Prezes Urzędu ― nakłada karę.</p><p>II. Na podstawie art. 77 ustawy...</p><h2>UZASADNIENIE</h2><p>Ustalono okoliczności sprawy.</p>`,
        { caseNumber: "RGD-16/2024", decisionType: "decyzja" },
      ),
    );

    expect(documentAst.blocks.slice(0, 6).map(roleOfBlock)).toEqual([
      "intro",
      "decision-title",
      "holding",
      "holding",
      "holding",
      "section-heading",
    ]);
    expect(documentAst.blocks.at(1)?.plainText).toBe("DECYZJA NR RGD-16/2024");
    expect(documentAst.blocks.at(-1)).toMatchObject({ role: "argumentation" });
  });

  test("classifies a court's `przyjmuje` operative clause as holding", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput("<p>przyjmuje skargę kasacyjną do rozpoznania.</p>", {
        decisionType: undefined,
      }),
    );

    expect(documentAst.blocks.at(0)).toMatchObject({ role: "holding" });
  });

  test.each(["x\n\nx\n\nx\n\nx", "x\r\n\r\nx\r\n\r\nx\r\n\r\nx"])(
    "rejects bounded plaintext %j before constructing paragraph strings",
    (content) => {
      const split = spyOn(String.prototype, "split");

      expect(() =>
        parsePlDecisionContent(
          baseInput(content, {
            htmlExpansionBudget: {
              ...PL_KIO_HTML_BUDGET,
              maxDomAllocations: 2,
            },
          }),
        ),
      ).toThrow(PlKioHtmlBudgetError);
      expect(split).not.toHaveBeenCalled();
      split.mockRestore();
    },
  );

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
        <p>SSA Tomasz Nowicki</p>
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
      "SSA Tomasz Nowicki",
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
      "<p><strong>Przewodniczący </strong><em>SSA Tomasz Nowicki</em></p>";

    const { documentAst } = parsePlDecisionContent(baseInput(content));

    const intro = documentAst.blocks.find(
      (block) => block.type === "paragraph" && block.plainText.includes("SSA"),
    );

    expect(intro?.plainText).toBe("Przewodniczący SSA Tomasz Nowicki");
  });
});

describe("markup whitespace", () => {
  const ADAPTER_FIXTURES = new URL(
    "../adapters/__fixtures__/",
    import.meta.url,
  );
  const gunzipText = async (name: string): Promise<string> =>
    new TextDecoder().decode(
      Bun.gunzipSync(
        new Uint8Array(
          await Bun.file(new URL(name, ADAPTER_FIXTURES)).arrayBuffer(),
        ),
      ),
    );
  // Captured HTML of the publishers this reader serves, each pretty-printed
  // or wrapped by its exporter.
  const CAPTURED_HTML = [
    "pl-ncourt-content-155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001.html.gz",
    "pl-ncourt-content-151020200002521_V_P_000335_2013_Uz_2015-11-02_001.html.gz",
    "pl-kio-content-30308.html.gz",
  ];

  const leavesOf = (blocks: readonly Block[]): string[] => {
    const leaves: string[] = [];
    const walk = (inlines: readonly Inline[]): void => {
      for (const inline of inlines) {
        if (inline.type === "text") {
          leaves.push(inline.text);
        } else if (hasInlineChildren(inline)) {
          walk(inline.children);
        }
      }
    };
    for (const block of blocks) {
      if (block.type === "table") {
        for (const cell of block.rows.flat()) {
          walk(cell.inlines);
        }
      } else if ("inlines" in block) {
        walk(block.inlines);
      }
    }
    return leaves;
  };

  test.each(CAPTURED_HTML)(
    "%s: no line break, tab or run of spaces of the markup reaches the text",
    async (name) => {
      const html = await gunzipText(name);
      // The capture reaches the fault: a paragraph whose markup puts a line
      // break or a run of spaces between two of its words.
      const $ = cheerio.load(html);
      expect(
        $("p")
          .toArray()
          .some((paragraph) =>
            /\S(?:[ \t]*\n|[ \t]{2,})\s*\S/u.test($(paragraph).text()),
          ),
      ).toBe(true);
      const { documentAst } = parsePlDecisionContent(
        baseInput(html, { decisionType: undefined }),
      );
      const leaves = leavesOf(documentAst.blocks);
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.filter((text) => /[\t\n\r\f]| {2}/u.test(text))).toEqual(
        [],
      );
    },
  );

  test("a source line break inside a paragraph reads as a space", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        '<p>Przewodniczący: <span class="underline">\n<!-- -->SSO A. B.</span>\n</p>',
        {
          decisionType: undefined,
        },
      ),
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Przewodniczący: SSO A. B.",
    ]);
  });

  const plainTextsOf = (html: string): string[] =>
    parsePlDecisionContent(
      baseInput(html, { decisionType: undefined }),
    ).documentAst.blocks.map((block) => block.plainText);

  test.each([
    ["<pre>A\tB\nC\tD</pre>", ["A\tB\nC\tD"]],
    ['<p style="white-space:pre-wrap">A  B\n  C</p>', ["A  B\n  C"]],
    ['<p style="white-space: pre">A\t\tB</p>', ["A\t\tB"]],
    ['<p style="white-space:break-spaces">A   B</p>', ["A   B"]],
    ['<p style="white-space:pre-line">A   B\n   C</p>', ["A B\nC"]],
    // Inherited from a container, and undone by a descendant.
    ['<div style="white-space:pre-wrap"><p>A  B</p></div>', ["A  B"]],
    [
      '<div style="white-space:pre-wrap"><p style="white-space:normal">A  B</p></div>',
      ["A B"],
    ],
    // The cascade's priority: the important declaration wins.
    [
      '<p style="white-space:pre !important; white-space:normal">A  B</p>',
      ["A  B"],
    ],
    // A block element its style keeps in the line ends no line.
    [
      '<table><tr><td>art. <div style="display:inline">3</div><div style="display:inline">94</div> k.p.c.</td></tr></table>',
      ["art. 394 k.p.c."],
    ],
    [
      '<table><tr><td>art. <div style="display: inline-block !important">3</div><span>94</span> k.p.c.</td></tr></table>',
      ["art. 394 k.p.c."],
    ],
    [
      '<table><tr><td><span style="display:block">A</span><span style="display:block">B</span></td></tr></table>',
      ["A\nB"],
    ],
  ])("%s keeps the whitespace its style preserves", (html, expected) => {
    expect(plainTextsOf(html)).toEqual(expected);
  });

  test("a kept line break is a line break inline, not text", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput("<pre>A\nB</pre>", { decisionType: undefined }),
    );
    expect(documentAst.blocks.at(0)).toMatchObject({
      inlines: [
        { type: "text", text: "A" },
        { type: "line-break" },
        { type: "text", text: "B" },
      ],
    });
  });

  test("paragraphs inside one cell stay apart, a line each", () => {
    // Captured KIO markup: each paragraph ends in a space and the next
    // follows with nothing between them.
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        "<table><tr><td><p><span>Sp. z o.o. </span></p><p><span>ul. Zabytkowa 2 </span></p></td></tr></table>",
        { decisionType: undefined },
      ),
    );
    const table = documentAst.blocks.find((block) => block.type === "table");
    expect(table?.rows[0]?.[0]?.plainText).toBe("Sp. z o.o.\nul. Zabytkowa 2");
  });
});

describe("ordered list items print the number a browser gives them", () => {
  const itemsOf = (html: string): string[] =>
    parsePlDecisionContent(
      baseInput(html, { decisionType: undefined }),
    ).documentAst.blocks.map((block) => block.plainText);

  test.each([
    ["<ol><li>a</li><li>b</li></ol>", ["1. a", "2. b"]],
    ['<ol start="4"><li>a</li><li>b</li></ol>', ["4. a", "5. b"]],
    [
      '<ol><li>a</li><li value="7">b</li><li>c</li></ol>',
      ["1. a", "7. b", "8. c"],
    ],
    [
      "<ol reversed><li>a</li><li>b</li><li>c</li></ol>",
      ["3. a", "2. b", "1. c"],
    ],
    ['<ol type="a"><li>a</li><li>b</li></ol>', ["a. a", "b. b"]],
    ['<ol type="A" start="27"><li>a</li></ol>', ["AA. a"]],
    ['<ol type="i" start="4"><li>a</li></ol>', ["iv. a"]],
    ['<ol type="I" start="9"><li>a</li><li>b</li></ol>', ["IX. a", "X. b"]],
    ['<ol type="I" start="0"><li>a</li></ol>', ["0. a"]],
    ["<ol><li>a</li><li> </li><li>c</li></ol>", ["1. a", "3. c"]],
    ['<ol style="list-style-type: none;"><li>a</li></ol>', ["a"]],
    ['<ol type="a" style="list-style-type: decimal"><li>a</li></ol>', ["1. a"]],
    [
      '<ol><li style="list-style: upper-roman inside">a</li><li>b</li></ol>',
      ["I. a", "2. b"],
    ],
    [
      '<ol style="list-style-type: none"><li style="list-style-type: lower-alpha">a</li></ol>',
      ["a. a"],
    ],
    // The cascade's priority: the important declaration wins.
    [
      '<ol><li style="list-style-type:none !important;list-style-type:decimal">A</li></ol>',
      ["A"],
    ],
    ['<ol style="list-style: inside"><li>a</li></ol>', ["a"]],
    // Counters outside a style's range print in decimal, and a counter past
    // the safe integer range is not one the list counts from.
    [
      '<ol type="I" start="3999"><li>a</li><li>b</li></ol>',
      ["MMMCMXCIX. a", "4000. b"],
    ],
    ['<ol type="i" start="4000"><li>a</li></ol>', ["4000. a"]],
    [
      '<ol type="a" start="-1"><li>a</li><li>b</li><li>c</li></ol>',
      ["-1. a", "0. b", "a. c"],
    ],
    ['<ol type="a" start="703"><li>a</li></ol>', ["aaa. a"]],
    ['<ol type="I" start="100000000000000000000"><li>a</li></ol>', ["I. a"]],
    [
      '<ol><li value="100000000000000000000">a</li><li>b</li></ol>',
      ["1. a", "2. b"],
    ],
    // A nested list is its own list, numbered on its own counter, in place.
    [
      '<ol><li>Parent<ol type="a"><li>Child</li></ol></li><li>Next</li></ol>',
      ["1. Parent", "a. Child", "2. Next"],
    ],
    [
      "<ol><li><div>Parent<ol><li>Child</li></ol></div></li></ol>",
      ["1. Parent", "1. Child"],
    ],
    ["<ol><li><div><p></p></div>Actual text</li></ol>", ["1. Actual text"]],
    [
      "<ol><li><div><span>Parent<ol><li><div>Child<ol><li>Grandchild</li></ol></div></li></ol> tail</span></div></li></ol>",
      ["1. Parent", "1. Child", "1. Grandchild", "tail"],
    ],
    [
      '<ol reversed><li>P<ol><li value="5">C1</li><li>C2</li></ol> tail</li><li>Q</li></ol>',
      ["2. P", "5. C1", "6. C2", "tail", "1. Q"],
    ],
    [
      '<ol start="3"><li><p>One</p><p>More</p></li><li><ul><li>Deep</li></ul></li></ol>',
      ["3. One", "More", "4.", "Deep"],
    ],
    ['<ol><li>a <p style="display:inline">b</p> c</li></ol>', ["1. a b c"]],
    ["<ul><li>a</li><li>b</li></ul>", ["a", "b"]],
  ])("%s", (html, expected) => {
    expect(itemsOf(html)).toEqual(expected);
  });

  test("reading an item's runs around its blocks costs work linear in the item", () => {
    // Every inline walk lists an element's children once; the total listed
    // is the work. Copying the item per run made it quadratic.
    type ContentsOwner = { contents: () => { length: number } };
    const ownsContents = (value: unknown): value is ContentsOwner =>
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "contents");
    // The prototype cheerio defines `contents` on, above each load's class.
    let contentsOwner: unknown = cheerio.load("<p></p>").root();
    while (contentsOwner !== null && !ownsContents(contentsOwner)) {
      contentsOwner = Object.getPrototypeOf(contentsOwner);
    }
    if (!ownsContents(contentsOwner)) {
      expect.unreachable("cheerio defines no contents method");
    }
    const owner = contentsOwner;
    const listed = (runs: number): number => {
      const spy = spyOn(owner, "contents");
      try {
        const { documentAst } = parsePlDecisionContent(
          baseInput(
            `<ol><li>${"text<p>paragraph</p>".repeat(runs)}</li></ol>`,
            {
              decisionType: undefined,
            },
          ),
        );
        expect(documentAst.blocks).toHaveLength(runs * 2);
        let total = 0;
        for (const result of spy.mock.results) {
          total += result.type === "return" ? result.value.length : 0;
        }
        return total;
      } finally {
        spy.mockRestore();
      }
    };
    const small = listed(100);
    const large = listed(400);
    // Four times the runs: about four times the work, never sixteen.
    expect(large / small).toBeLessThan(5);
  });

  test("numbering sibling list items takes linear work", () => {
    const attributeReads = (count: number) => {
      let reads = 0;
      const { documentAst } = parsePlDecisionContent(
        baseInput(`<ol>${"<li>Treść punktu</li>".repeat(count)}</ol>`, {
          decisionType: undefined,
          loadHtml: (html) => {
            const $ = cheerio.load(html);
            $("li").each((_, element) => {
              if (!isTag(element)) {
                return;
              }
              const attributes = element.attribs;
              Object.defineProperty(element, "attribs", {
                get: () => {
                  reads += 1;
                  return attributes;
                },
              });
            });
            return $;
          },
        }),
      );
      expect(documentAst.blocks).toHaveLength(count);
      expect(documentAst.blocks.at(-1)?.plainText).toBe(
        `${count}. Treść punktu`,
      );
      return reads;
    };
    const small = attributeReads(100);
    const large = attributeReads(1000);
    expect(large).toBeLessThanOrEqual(small * 11);
  });

  test("the number does not decide the item's role", () => {
    // A list in the reasons stays argumentation; a number the item states
    // itself would read as an operative point.
    const { documentAst } = parsePlDecisionContent(
      baseInput("<h2>UZASADNIENIE</h2><ol><li>Pytanie pierwsze?</li></ol>"),
    );
    expect(documentAst.blocks.at(-1)).toMatchObject({
      plainText: "1. Pytanie pierwsze?",
      role: "argumentation",
    });
    const preamble = parsePlDecisionContent(
      baseInput("<ol><li>Wnioskodawca zapytał.</li></ol>", {
        decisionType: undefined,
      }),
    );
    expect(preamble.documentAst.blocks.at(-1)).toMatchObject({
      plainText: "1. Wnioskodawca zapytał.",
      role: "intro",
    });
  });
});

describe("table caption retention", () => {
  test("keeps caption text once before its row in source order", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(
        `<p>Before.</p><table><caption><b>Source caption</b> tail.</caption><tr><td>Row value.</td></tr></table><p>After.</p>`,
        { decisionType: undefined },
      ),
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Before.",
      "Source caption tail.",
      "Row value.",
      "After.",
    ]);
  });

  test("keeps a caption even when its table has no rows", () => {
    const { documentAst } = parsePlDecisionContent(
      baseInput(`<table><caption>Caption without rows.</caption></table>`, {
        decisionType: undefined,
      }),
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Caption without rows.",
    ]);
  });
});

test("retains nested table text only in its owning outer cell", () => {
  const { documentAst, fulltext } = parsePlDecisionContent(
    baseInput(
      "<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></tbody><tfoot><tr><td>Footer</td></tr></tfoot></table>",
    ),
  );
  const table = documentAst.blocks.find((block) => block.type === "table");
  expect(table?.rows).toHaveLength(3);
  expect(fulltext.match(/Inner/gu)).toHaveLength(1);
  expect(fulltext).toContain("Header");
  expect(fulltext).toContain("Footer");
});
