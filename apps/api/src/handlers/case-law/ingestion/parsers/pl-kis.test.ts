/**
 * The tax administration's documents, read from the HTML the EUREKA detail
 * serves. Every fixture is a captured detail with a provenance sidecar.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { load } from "@stll/html";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import type { Block, Inline } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { plKisCategoryById } from "@/api/handlers/case-law/ingestion/adapters/pl-kis";
import {
  parsePlKisDocumentHtml as uncheckedParsePlKisDocumentHtml,
  parsePlKisDocumentPdf as uncheckedParsePlKisDocumentPdf,
} from "@/api/handlers/case-law/ingestion/parsers/pl-kis";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parsePlKisDocumentHtml = guardParser(uncheckedParsePlKisDocumentHtml);
const parsePlKisDocumentPdf = guardParser(uncheckedParsePlKisDocumentPdf);

const ADAPTER_FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);

/** Every captured detail, one per category the adapter ingests. */
const DETAIL_FIXTURES = [
  ...new Bun.Glob("pl-kis-detail-*.json.gz").scanSync(
    ADAPTER_FIXTURES.pathname,
  ),
]
  .toSorted()
  .map((name) => new URL(name, ADAPTER_FIXTURES));

/** DKP1.8082.1.2026, a protective opinion the export wraps at a fixed width. */
const WRAPPED = new URL("pl-kis-detail-15-opz.json.gz", ADAPTER_FIXTURES);

/** ILPB3/423-78/07-2/HS, whose questions are an ordered list. */
const NUMBERED_QUESTIONS = new URL(
  "__fixtures__/pl-kis-ilpb3-423-78-07-2-hs.json.gz",
  import.meta.url,
);

const fieldOf = async (detail: URL, key: string): Promise<unknown> => {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await Bun.file(detail).arrayBuffer())),
    ),
  );
  const fields =
    typeof parsed === "object" &&
    parsed !== null &&
    "dokument" in parsed &&
    typeof parsed.dokument === "object" &&
    parsed.dokument !== null &&
    "fields" in parsed.dokument &&
    Array.isArray(parsed.dokument.fields)
      ? parsed.dokument.fields
      : [];
  return fields.find(
    (field: unknown) =>
      typeof field === "object" &&
      field !== null &&
      "key" in field &&
      field.key === key,
  )?.value;
};

const htmlOf = async (detail: URL): Promise<string> => {
  const html = await fieldOf(detail, "TRESC_INTERESARIUSZ");
  return typeof html === "string" ? html : "";
};

/** The decision type the adapter stores for a detail: its category's. */
const decisionTypeOf = async (detail: URL): Promise<string | undefined> => {
  const category = plKisCategoryById(
    Number(await fieldOf(detail, "KATEGORIA_INFORMACJI")),
  );
  return category?.disposition === "included"
    ? category.decisionType
    : undefined;
};

const parse = (html: string) =>
  parsePlKisDocumentHtml({
    html,
    caseNumber: "x",
    court: "x",
    decisionDate: undefined,
    decisionType: "interpretacja indywidualna",
    sourceUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentId: "1",
    keywords: [],
    statutes: [],
  });

/** Every text leaf of every block, table cells included. */
const textLeaves = (blocks: readonly Block[]): string[] => {
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

describe("source whitespace", () => {
  test("preserves structured blocks around printed-line runs", () => {
    const { documentAst } = parse(
      "<h2>Heading</h2><p>First paragraph.</p><p>Second paragraph.</p>",
    );

    expect(
      documentAst.blocks.map(({ type, plainText }) => [type, plainText]),
    ).toEqual([
      ["heading", "Heading"],
      ["paragraph", "First paragraph."],
      ["paragraph", "Second paragraph."],
    ]);
  });

  test("joins an inline printed-line run without absorbing surrounding blocks", () => {
    const { documentAst } = parse(
      "<p>Before.</p>First line<br>second line.<p>After.</p>",
    );

    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Before.",
      "First line second line.",
      "After.",
    ]);
  });

  test.each(["\n", " "])(
    "treats two printed-line breaks separated by %j as a paragraph boundary",
    (separator) => {
      const { documentAst } = parse(`First<br>${separator}<br>Second`);

      expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
        "First",
        "Second",
      ]);
    },
  );

  test("keeps a single printed-line break within one paragraph", () => {
    const { documentAst } = parse("First<br>Second");

    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "First Second",
    ]);
  });

  test.each([
    [
      "czynności, o których mowa w art. 5, są klasyfikowane według Nomenklatury scalonej (CN)",
      "lub klasyfikacji wydanych na podstawie przepisów o statystyce publicznej.",
    ],
    [
      "Podstawową właściwością tych produktów jest to, że powracają one do stanu ciekłego",
      "lub półciekłego, w temperaturze otoczenia zbliżonej do 0 °C.",
    ],
    [
      "1) następującym po dniu doręczenia decyzji o zmianie WIS albo decyzji o uchyleniu WIS,",
      "albo",
    ],
  ])(
    "a word-processor line break does not cut its Polish sentence",
    (above, below) => {
      const { documentAst } = parse(`${above} <br>${below}`);
      expect(documentAst.blocks.map((block) => block.plainText)).toContain(
        `${above} ${below}`,
      );
      expect(documentAst.blocks.map((block) => block.plainText)).not.toContain(
        below,
      );
    },
  );

  test("the fixtures carry the export's line wraps inside paragraphs", async () => {
    // A wrap between two words, inside one element: what the parse must fold.
    expect(await htmlOf(WRAPPED)).toMatch(/\p{L}\n\p{L}/u);
  });

  test.each(
    DETAIL_FIXTURES.map((url) => [url.pathname.split("/").at(-1), url]),
  )(
    "%s: no line wrap, tab or run of spaces from the markup reaches the text",
    async (_name, detail) => {
      const html = await htmlOf(detail);
      if (html === "") {
        return;
      }
      const { documentAst } = parse(html);
      const leaves = textLeaves(documentAst.blocks);
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.filter((text) => /[\t\n\r\f]| {2}/u.test(text))).toEqual(
        [],
      );
    },
  );

  test("a wrapped paragraph reads as the sentence it is", async () => {
    const { fulltext } = parse(await htmlOf(WRAPPED));
    expect(fulltext).toContain(
      "W przedstawionej we wniosku planowanej czynności bierze udział 5 spółek",
    );
    expect(fulltext).toContain(
      "darowizna udziałów oraz akcji posiadanych przez OF odpowiednio w Spółce B oraz Spółce C na rzecz FR;",
    );
  });
});

describe("web navigation and footnotes", () => {
  test("a line that only links back within the document is not the text", () => {
    const { documentAst } = parse(
      '<p>Pierwsza część opisu.</p><p><a anchor="powrót do spisu">powrót do spisu</a></p><p>Druga część opisu.</p>',
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Pierwsza część opisu.",
      "Druga część opisu.",
    ]);
  });

  test("a footnote mark inside a sentence stays", () => {
    const { documentAst } = parse(
      '<p>Zgodnie z przepisem<a href="#_ftn1">[1]</a> podatnik składa deklarację.</p>',
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Zgodnie z przepisem[1] podatnik składa deklarację.",
    ]);
  });

  test("a footnote's line its sentence runs across joins the line above", () => {
    const { documentAst } = parse(
      '<p>Tekst pisma.</p><div id="ftn6"><p><a href="#_ftnref6">[6]</a> Rozporządzenie Ministra Finansów i Gospodarki z dnia 7 grudnia 2025 r. zmieniające</p><p>rozporządzenie w sprawie wystawiania faktur (Dz. U. poz. 1742).</p></div><div id="ftn7"><p><a href="#_ftnref7">[7]</a> Art. 106b ust. 3 pkt 1a ustawy o VAT.</p><p>Drugi akapit przypisu.</p></div>',
    );
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Tekst pisma.",
      "[6] Rozporządzenie Ministra Finansów i Gospodarki z dnia 7 grudnia 2025 r. zmieniające rozporządzenie w sprawie wystawiania faktur (Dz. U. poz. 1742).",
      "[7] Art. 106b ust. 3 pkt 1a ustawy o VAT.",
      "Drugi akapit przypisu.",
    ]);
  });
});

describe("ordered lists", () => {
  test("a list styled to print no number gets none", async () => {
    const html = await htmlOf(
      new URL("pl-kis-detail-05-objas.json.gz", ADAPTER_FIXTURES),
    );
    const $ = load(html);
    const items = $("ol[style*='list-style-type: none'] > li")
      .toArray()
      .map((item) => $(item).text().replace(/\s+/gu, " ").trim())
      .filter((text) => text !== "");
    expect(items).not.toEqual([]);
    // A no-break space before an item's title stays in its text; compare
    // words, not the width of the gap.
    const texts = parse(html).documentAst.blocks.map((block) =>
      block.plainText.replace(/\s+/gu, " "),
    );
    for (const item of items) {
      expect(texts, item).toContain(item);
    }
  });

  test("each question keeps the number its answer cites", async () => {
    const { fulltext } = parse(await htmlOf(NUMBERED_QUESTIONS));
    const questions = [
      "1. Jaki jest katalog aktywów",
      "2. Kiedy zwrot środków",
      "3. Kiedy Spółka powinna rozpoznać przychód",
      "4. W jaki sposób rozliczyć",
      "5. Kiedy wydatki ponoszone",
    ];
    const answers = ["Ad. 1", "Ad. 2", "Ad. 3", "Ad. 4", "Ad. 5"];
    let from = 0;
    for (const question of questions) {
      const at = fulltext.indexOf(question, from);
      expect(at, question).toBeGreaterThanOrEqual(0);
      from = at;
    }
    for (const answer of answers) {
      expect(fulltext.indexOf(answer, from), answer).toBeGreaterThan(from);
    }
  });

  test.each(
    DETAIL_FIXTURES.map((url) => [url.pathname.split("/").at(-1), url]),
  )(
    "%s: an item of a plain ordered list opens with its count",
    async (_name, detail) => {
      const html = await htmlOf(detail);
      const $ = load(html);
      const items = $(
        "ol:not([type]):not([start]):not([reversed]):not([style*='list-style'])",
      )
        .toArray()
        .flatMap((list) =>
          $(list)
            .children("li:not([value])")
            .toArray()
            .map((item, index) => ({
              number: index + 1,
              text: $(item).text().replace(/\s+/gu, " ").trim(),
            })),
        )
        .filter(({ text }) => text !== "");
      const { documentAst } = parse(html);
      const texts = documentAst.blocks.map((block) =>
        block.plainText.replace(/\s+/gu, " "),
      );
      for (const { number, text } of items) {
        const opening = `${number}. ${text.slice(0, 40)}`;
        expect(
          texts.some((plainText) => plainText.startsWith(opening)),
          opening,
        ).toBe(true);
      }
    },
  );
});

test("the recorded PDF rendition satisfies the reader contract", async () => {
  const parsed = await parsePlKisDocumentPdf({
    pdfBytes: await Bun.file(
      new URL("pl-kis-document-05-objas.pdf", ADAPTER_FIXTURES),
    ).bytes(),
    caseNumber: "recorded-pdf",
    court: "Minister Finansow",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentId: "1",
    keywords: [],
    statutes: [],
  });
  expect(parsed.fulltext).toContain("waloryzacji");
});

const PARSER_FIXTURES = new URL("__fixtures__/", import.meta.url);

/** DKP1.8082.1.2026: information on a protective opinion issued. */
const PROTECTIVE_OPINION = WRAPPED;

/** 0111-KDGB.480.2.2026.4.JSZ: a decision refusing a top-up tax opinion. */
const OPINION_REFUSAL = new URL(
  "pl-kis-0111-kdgb-480-2-2026-4-jsz.json.gz",
  PARSER_FIXTURES,
);

/** ILPB2/415-61/07-2/JK: an individual interpretation in the 2007 layout. */
const INTERPRETATION_2007 = new URL(
  "pl-kis-ilpb2-415-61-07-2-jk.json.gz",
  PARSER_FIXTURES,
);

/** Every captured EUREKA detail: one per category, and the parser's own. */
const EVERY_DETAIL = [
  ...DETAIL_FIXTURES,
  ...[...new Bun.Glob("**/pl-kis-*.json.gz").scanSync(PARSER_FIXTURES.pathname)]
    .toSorted()
    .map((name) => new URL(name, PARSER_FIXTURES)),
];

/** A detail parsed as the adapter parses it, with its category's type. */
const parseDetail = async (detail: URL) =>
  parsePlKisDocumentHtml({
    html: await htmlOf(detail),
    caseNumber: "x",
    court: "x",
    decisionDate: undefined,
    decisionType: await decisionTypeOf(detail),
    sourceUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentId: "1",
    keywords: [],
    statutes: [],
  });

const singleSpaced = (text: string): string => text.replaceAll(/\s+/gu, " ");

type Part = {
  type: string;
  role: string | undefined;
  text: string;
};

/** Each block as its type, role and text, spaces made single. */
const partsOf = (blocks: readonly Block[]): Part[] =>
  blocks.map((block) => ({
    type: block.type,
    role: "role" in block ? block.role : undefined,
    text: singleSpaced(block.plainText),
  }));

const partWith = (blocks: readonly Block[], opening: string) =>
  partsOf(blocks).find((part) => part.text.startsWith(opening));

describe("the parts of a letter", () => {
  test.each(EVERY_DETAIL.map((url) => [url.pathname.split("/").at(-1), url]))(
    "%s: the reading tells the document's parts apart",
    async (_name, detail) => {
      if ((await htmlOf(detail)) === "") {
        return;
      }
      const { documentAst, structure } = await parseDetail(detail);
      const roles = new Set(
        documentAst.blocks.flatMap((block) =>
          block.type === "paragraph" ? [block.role] : [],
        ),
      );
      expect(roles.size).toBeGreaterThan(1);
      expect(structure).toEqual({ type: "divided" });
    },
  );

  test("a protective opinion's information: title, ruling, sections, reasons", async () => {
    const { documentAst } = await parseDetail(PROTECTIVE_OPINION);
    const parts = partsOf(documentAst.blocks);
    expect(parts.slice(0, 3)).toEqual([
      {
        type: "heading",
        role: "decision-title",
        text: "INFORMACJA O WYDANIU OPINII ZABEZPIECZAJĄCEJ",
      },
      {
        type: "paragraph",
        role: "holding",
        text: expect.stringMatching(
          /^Dnia 3 września 2026 r\. – na podstawie art\. 119y § 1 .* Szef Krajowej Administracji Skarbowej wydał opinię zabezpieczającą\.$/u,
        ),
      },
      {
        type: "heading",
        role: "section-heading",
        text: "A. ZWIĘZŁY OPIS CZYNNOŚCI",
      },
    ]);
    const headings = parts.flatMap((part) =>
      part.role === "section-heading" ? [part.text] : [],
    );
    expect(headings).toEqual([
      "A. ZWIĘZŁY OPIS CZYNNOŚCI",
      "B. WYJAŚNIENIE POWODÓW PODJĘTEGO ROZSTRZYGNIĘCIA",
      "i. Istnienie korzyści podatkowej",
      "ii. Korzyść podatkowa jest głównym lub jednym z głównych celów czynności",
      "iii. Sprzeczność korzyści z przedmiotem lub celem ustawy podatkowej lub jej przepisu",
      "iv. Sztuczność sposobu działania",
    ]);
    expect(
      partWith(documentAst.blocks, "Szef KAS stwierdził również, że czynność"),
    ).toMatchObject({ type: "paragraph", role: "argumentation" });
    // One ruling: the reasons' own conclusions are not a second one.
    expect(parts.filter((part) => part.role === "holding")).toHaveLength(1);
  });

  test("a refusal under the template's styles: title, ruling, sections, instruction", async () => {
    const { documentAst } = await parseDetail(OPINION_REFUSAL);
    const parts = partsOf(documentAst.blocks);
    expect(parts.slice(0, 3)).toEqual([
      {
        type: "heading",
        role: "decision-title",
        text: "Postanowienie o odmowie wydania opinii w sprawie opodatkowania wyrównawczego",
      },
      {
        type: "paragraph",
        role: "holding",
        text: expect.stringMatching(
          /^Dyrektor Krajowej Informacji Skarbowej odmawia wydania opinii w sprawie opodatkowania wyrównawczego na podstawie wniosku z 29 stycznia 2026 r\./u,
        ),
      },
      { type: "heading", role: "section-heading", text: "Zakres wniosku" },
    ]);
    const headings = parts.flatMap((part) =>
      part.role === "section-heading" ? [part.text] : [],
    );
    expect(headings).toEqual([
      "Zakres wniosku",
      "Opis czynności przedstawiony przez Zainteresowanego",
      "Pytanie Zainteresowanego",
      "Uzasadnienie odmowy wydania opinii w sprawie opodatkowania wyrównawczego",
      "Przepisy o opinii w sprawie opodatkowania wyrównawczego a przepisy zapobiegające unikaniu opodatkowania",
      "Ocena czynności przedstawionych we wniosku",
      "Opinia Szefa KAS w sprawie czynności przedstawionych we wniosku",
      "Pouczenie o prawie do zażalenia",
      "Podstawa prawna",
    ]);
    // The instruction on the remedy is neither the ruling nor its reasons.
    expect(
      partWith(
        documentAst.blocks,
        "Na niniejsze postanowienie służy zażalenie do Dyrektora Krajowej Informacji Skarbowej",
      ),
    ).toMatchObject({ type: "paragraph", role: undefined });
    expect(
      partWith(documentAst.blocks, "W zażaleniu powinny być wskazane zarzuty"),
    ).toMatchObject({ type: "paragraph", role: undefined });
    expect(
      partWith(documentAst.blocks, "Przedmiotem działalności A"),
    ).toMatchObject({ type: "paragraph", role: "argumentation" });
  });

  test("an interpretation in the 2007 layout reads as it did", async () => {
    const { documentAst } = await parseDetail(INTERPRETATION_2007);
    const parts = partsOf(documentAst.blocks);
    expect(parts.slice(0, 3)).toEqual([
      {
        type: "heading",
        role: "decision-title",
        text: "INTERPRETACJA INDYWIDUALNA",
      },
      {
        type: "paragraph",
        role: "holding",
        text: expect.stringMatching(
          /^Na podstawie art\. 14b § 1 i § 6 .* stwierdza, że stanowisko .* jest prawidłowe\.$/u,
        ),
      },
      { type: "heading", role: "section-heading", text: "UZASADNIENIE" },
    ]);
    // A sentence set in bold for emphasis is the text, not a heading.
    expect(
      partWith(
        documentAst.blocks,
        "W przedmiotowym wniosku został przedstawiony następujący stan faktyczny.",
      ),
    ).toMatchObject({ type: "paragraph", role: "argumentation" });
    expect(
      partWith(
        documentAst.blocks,
        "Stronie przysługuje prawo do wniesienia skargi",
      ),
    ).toMatchObject({ type: "paragraph", role: undefined });
  });

  test("an authority's name set apart above its ruling runs on into it", async () => {
    const { documentAst } = await parseDetail(
      new URL("pl-kis-detail-09-wis-uch.json.gz", ADAPTER_FIXTURES),
    );
    expect(partsOf(documentAst.blocks).slice(0, 7)).toEqual([
      { type: "heading", role: "decision-title", text: "DECYZJA" },
      {
        type: "paragraph",
        role: "intro",
        text: expect.stringMatching(/^Na podstawie art\. 221 i art\. 233 § 2/u),
      },
      {
        type: "paragraph",
        role: "intro",
        text: "Dyrektor Krajowej Informacji Skarbowej",
      },
      {
        type: "paragraph",
        role: "intro",
        text: expect.stringMatching(/^po ponownym rozpatrzeniu odwołania/u),
      },
      {
        type: "paragraph",
        role: "holding",
        text: "uchyla w całości decyzję Organu pierwszej instancji",
      },
      {
        type: "paragraph",
        role: "holding",
        text: "i przekazuje sprawę do ponownego rozpatrzenia.",
      },
      { type: "heading", role: "section-heading", text: "UZASADNIENIE" },
    ]);
  });
});

/** Lines a letter's template sets as its headings, none ending a sentence. */
const SECTION_HEADINGS = [
  "Zakres wniosku",
  "Opis stanu faktycznego",
  "Pytania",
  "Ocena stanowiska",
  "Uzasadnienie interpretacji indywidualnej",
  "Dodatkowe informacje",
];
const TITLES = [
  "Interpretacja indywidualna – stanowisko prawidłowe",
  "INFORMACJA O WYDANIU OPINII ZABEZPIECZAJĄCEJ",
  "Postanowienie o odmowie wydania opinii",
];
/**
 * A letter's opening: the ruling in the authority's voice, after the
 * salutation where the authority signs in the first person.
 */
const OPENINGS = [
  {
    salutation: ["Szanowni Państwo,"],
    ruling: "stwierdzam, że Państwa stanowisko jest prawidłowe.",
  },
  {
    salutation: [],
    ruling: "Dyrektor Krajowej Informacji Skarbowej odmawia wydania opinii.",
  },
  {
    salutation: [],
    ruling:
      "Szef Krajowej Administracji Skarbowej wydał opinię zabezpieczającą.",
  },
  {
    salutation: [],
    ruling:
      "Działając na podstawie art. 14a § 1 Ordynacji podatkowej, zmieniam interpretację ogólną.",
  },
];
const SENTENCES = [
  "Spółka jest podatnikiem podatku akcyzowego.",
  "Wniosek wpłynął w terminie.",
  "Przepis ten stosuje się odpowiednio.",
  "Dochód podlega opodatkowaniu w Polsce.",
];

/** The ways the template sets a line apart as a heading. */
const SET_APART = [
  (line: string) => `<p class="TekstpismaKAS"><strong>${line}</strong></p>`,
  (line: string) => `<p class="2rdtytu">${line}</p>`,
  (line: string) => `<p class="MsoNormal"><b><span>${line}</span></b></p>`,
  (line: string) => `<p style="font-weight: bold">${line}</p>`,
];
const paragraph = (line: string) => `<p class="TekstpismaKAS">${line}</p>`;

describe("the template's layout, whatever the document", () => {
  test("title, ruling, then each heading over its section of the body", () => {
    assertProperty(
      "title, ruling, then each heading over its section of the body",
      fc.property(
        fc.constantFrom(...TITLES),
        fc.constantFrom(...OPENINGS),
        fc.uniqueArray(
          fc.record({
            heading: fc.constantFrom(...SECTION_HEADINGS),
            body: fc.array(fc.constantFrom(...SENTENCES), {
              minLength: 1,
              maxLength: 3,
            }),
          }),
          {
            minLength: 1,
            maxLength: 4,
            selector: (section) => section.heading,
          },
        ),
        fc.constantFrom(...SET_APART),
        (title, { salutation, ruling }, sections, setApart) => {
          const html = [
            setApart(title),
            ...salutation.map(paragraph),
            paragraph(ruling),
            ...sections.flatMap(({ heading, body }) => [
              setApart(heading),
              ...body.map(paragraph),
            ]),
          ].join("\n");
          const { documentAst, structure } = parse(html);
          expect(partsOf(documentAst.blocks)).toEqual([
            { type: "heading", role: "decision-title", text: title },
            ...salutation.map((text) => ({
              type: "paragraph",
              role: "intro",
              text,
            })),
            { type: "paragraph", role: "holding", text: ruling },
            ...sections.flatMap(({ heading, body }) => [
              { type: "heading", role: "section-heading", text: heading },
              ...body.map((text) => ({
                type: "paragraph",
                role: "argumentation",
                text,
              })),
            ]),
          ]);
          expect(structure).toEqual({ type: "divided" });
        },
      ),
    );
  });

  test("a line set apart that the next line goes on from stays its paragraph", () => {
    assertProperty(
      "a line set apart that the next line goes on from stays its paragraph",
      fc.property(
        fc.constantFrom(
          "Dyrektor Krajowej Informacji Skarbowej",
          "Szanowni Państwo,",
          "Szef Krajowej Administracji Skarbowej",
        ),
        fc.constantFrom(
          "po rozpatrzeniu wniosku z 1 stycznia 2026 r.",
          "w związku z wnioskiem z 1 stycznia 2026 r.",
        ),
        fc.constantFrom(...SET_APART),
        (line, continuation, setApart) => {
          const { documentAst } = parse(
            [setApart("DECYZJA"), setApart(line), paragraph(continuation)].join(
              "\n",
            ),
          );
          expect(partWith(documentAst.blocks, line)).toMatchObject({
            type: "paragraph",
          });
        },
      ),
    );
  });
});
