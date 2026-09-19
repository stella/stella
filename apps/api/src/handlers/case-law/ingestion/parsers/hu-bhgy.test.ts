/**
 * The Hungarian parser, twice over.
 *
 * The first half is fixture-free: a document is written out as folio blocks, so
 * a failure names the construct the parser read wrong rather than a decision.
 * The second half drives the two readers over decisions the publisher actually
 * served — one from each era — and asserts the AST they produce, which is the
 * only place the DOCX-versus-RTF difference is visible.
 */

import { describe, expect, test } from "bun:test";

import type {
  BlockContent,
  Footnote,
  Document as FolioDocument,
  Paragraph,
  ParagraphAlignment,
} from "@stll/docx-core/model";
import { parseDocx } from "@stll/folio-core/server";

import type { Block } from "@/api/handlers/case-law/document-ast";
import {
  huDecisionDateFrom,
  huDecisionTypeFrom,
  huDocketFrom,
  parseHuBhgyDecision,
} from "@/api/handlers/case-law/ingestion/parsers/hu-bhgy";
import { readRtf } from "@/api/lib/legal-search/parsers/rtf-reader";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const CENTERED: ParagraphAlignment = "center";

type LineSpec = {
  text: string;
  bold?: boolean;
  centered?: boolean;
};

const paragraphOf = ({ bold, centered, text }: LineSpec): Paragraph => ({
  type: "paragraph",
  ...(centered === true ? { formatting: { alignment: CENTERED } } : {}),
  content: [
    {
      type: "run",
      ...(bold === true ? { formatting: { bold: true } } : {}),
      content: [{ type: "text", text }],
    },
  ],
});

const documentOf = (
  lines: readonly LineSpec[],
  footnotes: readonly Footnote[] = [],
): FolioDocument => {
  const content: BlockContent[] = lines.map(paragraphOf);
  return {
    package: {
      document: { content },
      ...(footnotes.length === 0 ? {} : { footnotes: [...footnotes] }),
    },
  };
};

const parse = (lines: readonly LineSpec[], footnotes?: readonly Footnote[]) =>
  parseHuBhgyDecision({
    document: documentOf(lines, footnotes),
    listedCaseNumber: "Gfv.30091/2025/4",
    court: "Kúria",
    sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok?azonosito=x",
    documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/?azonosito=x",
    documentId: "3cca08de",
    statutes: [],
  });

const shapeOfBlock = (block: Block): string => {
  if (block.type === "heading") {
    return `h${block.level}:${block.role ?? ""}:${block.plainText}`;
  }
  if (block.type === "paragraph") {
    const number = block.number === undefined ? "" : `#${block.number}`;
    return `p:${block.role ?? ""}${number}:${block.plainText}`;
  }
  return `${block.type}:${block.plainText}`;
};

const shapeOf = (blocks: readonly Block[]): string[] =>
  blocks.map(shapeOfBlock);

// ── Dates, kinds and dockets ─────────────────────────────

describe("the decision's own date", () => {
  test("reads the spelled month the current era prints", () => {
    expect(huDecisionDateFrom("Budapest, 2025. október 1.")).toBe("2025-10-01");
    expect(huDecisionDateFrom("Győr, 2009. június 30. napján")).toBe(
      "2009-06-30",
    );
  });

  test("reads the all-numeric form the legacy era prints", () => {
    expect(huDecisionDateFrom("Budapest, 2024.05.06.")).toBe("2024-05-06");
  });

  test("a line with no date states none, rather than a guess from the year", () => {
    expect(huDecisionDateFrom("Rendelkező rész")).toBeUndefined();
    expect(huDecisionDateFrom("Budapest, 2025. brumaire 1.")).toBeUndefined();
  });
});

describe("the decision's kind", () => {
  test("is the dictionary form, lowercase, whatever case the title prints", () => {
    expect(huDecisionTypeFrom(["A Kúria", "ítélete"])).toBe("ítélet");
    expect(huDecisionTypeFrom(["V É G Z É S T :"])).toBe("végzés");
    expect(huDecisionTypeFrom(["jogegységi határozat"])).toBe(
      "jogegységi határozat",
    );
  });

  test("a title naming no kind states none", () => {
    expect(
      huDecisionTypeFrom(["Az ügy száma: Gfv.30091/2025/4"]),
    ).toBeUndefined();
  });
});

describe("the docket the document prints", () => {
  test("is read from the labelled line of the current era", () => {
    expect(huDocketFrom(["Az ügy száma:      Gfv.VI.30.091/2025/4."])).toBe(
      "Gfv.VI.30.091/2025/4",
    );
  });

  test("is read from the `szám` line of the legacy era", () => {
    expect(huDocketFrom(["Bhar.31/2009/6. szám"])).toBe("Bhar.31/2009/6");
    expect(huDocketFrom(["Pf.III.20.723/2009/5. szám"])).toBe(
      "Pf.III.20.723/2009/5",
    );
  });
});

// ── Structure ────────────────────────────────────────────

describe("reading a document folio handed over", () => {
  test("the publisher's section headings cut the decision", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "ítélete" },
      { text: "Rendelkező rész" },
      { text: "A Kúria a jogerős ítéletet hatályában fenntartja." },
      { text: "Indokolás" },
      { text: "A felülvizsgálat alapjául szolgáló tényállás" },
      { text: "[1]\tAz alperes közgyűlése." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:decision-title:A Kúria",
      "p:intro:ítélete",
      "h1:section-heading:Rendelkező rész",
      "p:holding:A Kúria a jogerős ítéletet hatályában fenntartja.",
      "h1:section-heading:Indokolás",
      "h2:section-heading:A felülvizsgálat alapjául szolgáló tényállás",
      "p:argumentation#1:Az alperes közgyűlése.",
    ]);
  });

  test("the court's bracketed number is structure, not a prefix in the text", () => {
    const [, block] = parse([
      { text: "Indokolás" },
      { text: "[31]     A felülvizsgálati kérelem nem vezetett eredményre." },
    ]).documentAst.blocks;
    expect(block?.type).toBe("paragraph");
    expect(block?.type === "paragraph" ? block.number : null).toBe(31);
    expect(block?.plainText).toBe(
      "A felülvizsgálati kérelem nem vezetett eredményre.",
    );
  });

  test("the legacy era's spaced capitals open the operative part", () => {
    const parsed = parse([
      { text: "SZEGEDI ÍTÉLŐTÁBLA", bold: true },
      { text: "Í T É L E T E T :", bold: true, centered: true },
      { text: "Az elsőfokú bíróság ítéletét helybenhagyja." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:decision-title:SZEGEDI ÍTÉLŐTÁBLA",
      "h1:section-heading:Í T É L E T E T :",
      "p:holding:Az elsőfokú bíróság ítéletét helybenhagyja.",
    ]);
  });

  test("front-matter labels carry the role each names", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "Az ügy száma: Gfv.VI.30.091/2025/4." },
      { text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke" },
      { text: "A felperes: név1 (cím1)" },
      { text: "A felperes képviselője: Dr. Példa Ügyvédi Iroda (cím2)" },
      { text: "A per tárgya: közgyűlési határozatok hatályon kívül helyezése" },
      {
        text: "A másodfokú bíróság neve és a jogerős határozat száma: Fővárosi Ítélőtábla, 13.Gf.40.203/2024/8-II.",
      },
    ]);
    expect(
      parsed.documentAst.blocks.map((block) =>
        block.type === "paragraph" ? block.role : block.type,
      ),
    ).toEqual([
      "heading",
      "case-number",
      "panel",
      "parties",
      "counsel",
      "front-matter",
      "history",
    ]);
    expect(parsed.relatedProceedings).toHaveLength(1);
  });

  test("the panel block names the bench in the parts the court states", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke" },
      { text: "Dr. Minta Béla előadó bíró" },
      { text: "Dr. Teszt Csilla bíró" },
      { text: "A felperes: név1 (cím1)" },
      { text: "Rendelkező rész" },
      { text: "A Kúria a jogerős ítéletet hatályában fenntartja." },
    ]);
    expect(parsed.judges).toEqual([
      { role: "presiding", nameAsPrinted: "Dr. Példa Anna" },
      { role: "rapporteur", nameAsPrinted: "Dr. Minta Béla" },
      { role: "panel-member", nameAsPrinted: "Dr. Teszt Csilla" },
    ]);
  });

  test("a bench written on one line is cut on the court's own separators", () => {
    const parsed = parse([
      { text: "A Kúria" },
      {
        text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke / Dr. Minta Béla előadó bíró / Dr. Teszt Csilla bíró",
      },
      { text: "Rendelkező rész" },
    ]);
    expect(parsed.judges.map(({ role }) => role)).toEqual([
      "presiding",
      "rapporteur",
      "panel-member",
    ]);
  });

  test("the header's labels are what the field inventory reads back", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "Az ügy száma: Gfv.VI.30.091/2025/4." },
      { text: "Az alperesek: cég1 (cím3)" },
      { text: "Az alperesek képviselője: Példa Ügyvédi Iroda" },
      { text: "Rendelkező rész" },
      // Past the header a sentence opens with the same words, and the labels
      // stop there.
      { text: "Az alperesek felülvizsgálati kérelmet nyújtottak be." },
    ]);
    expect(parsed.headerLabels).toEqual([
      "Az ügy száma",
      "Az alperes",
      "Az alperes képviselője",
    ]);
    expect(
      parsed.documentAst.blocks.map((block) =>
        block.type === "paragraph" ? block.role : block.type,
      ),
    ).toEqual([
      "heading",
      "case-number",
      "parties",
      "counsel",
      "heading",
      "holding",
    ]);
  });

  test("the closing formula dates the decision and opens the signature block", () => {
    const parsed = parse([
      { text: "Indokolás" },
      { text: "[1] A Kúria döntése." },
      { text: "Budapest, 2025. október 1." },
      { text: "Dr. Példa Anna s.k. a tanács elnöke" },
      { text: "A kiadmány hiteléül:" },
    ]);
    expect(parsed.decisionDate).toBe("2025-10-01");
    expect(shapeOf(parsed.documentAst.blocks).slice(-3)).toEqual([
      "p:closing:Budapest, 2025. október 1.",
      "p:signature:Dr. Példa Anna s.k. a tanács elnöke",
      "p:apparatus:A kiadmány hiteléül:",
    ]);
  });

  test("a footnote is apparatus carrying its mark, wherever the body left off", () => {
    // The notes are walked after the body, which by then has reached the
    // signature block, and one may read like the document's own structure.
    // Both were classified as the line they are not, and the mark the note
    // hangs from went with the classification.
    const parsed = parse(
      [
        { text: "Indokolás" },
        { text: "[1] A Kúria döntése." },
        { text: "Budapest, 2025. október 1." },
        { text: "Dr. Példa Anna s.k. a tanács elnöke" },
      ],
      [
        {
          type: "footnote",
          id: 3,
          content: [paragraphOf({ text: "A Ptk. 6:1. §-a." })],
        },
        {
          type: "footnote",
          id: 4,
          content: [paragraphOf({ text: "Indokolás" })],
        },
      ],
    );
    const notes = parsed.documentAst.blocks.filter(
      (block) => block.type === "paragraph" && block.note !== undefined,
    );
    expect(notes.map(shapeOfBlock)).toEqual([
      "p:apparatus:A Ptk. 6:1. §-a.",
      "p:apparatus:Indokolás",
    ]);
    expect(notes.at(0)).toMatchObject({
      note: { type: "footnote", label: "3", noteId: "fn-3" },
    });
  });

  test("a line the parser does not recognise is still a paragraph in order", () => {
    // Rule 10: classification is a promotion from "paragraph", never a filter.
    const parsed = parse([
      { text: "Indokolás" },
      { text: "Egy mondat, amelyet a parser nem ismer fel." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:section-heading:Indokolás",
      "p:argumentation:Egy mondat, amelyet a parser nem ismer fel.",
    ]);
  });
});

describe("anonymisation", () => {
  test("a numbered placeholder is marked, and only the placeholder", () => {
    const [, block] = parse([
      { text: "A Kúria" },
      { text: "A felperes: név1 (cím1) képviseletében" },
    ]).documentAst.blocks;
    const inlines = block?.type === "paragraph" ? block.inlines : [];
    expect(
      inlines.map((inline) =>
        inline.type === "text"
          ? [inline.text, inline.anonymized === true]
          : [inline.type, false],
      ),
    ).toEqual([
      ["A felperes: ", false],
      ["név1", true],
      [" (", false],
      ["cím1", true],
      [") képviseletében", false],
    ]);
  });

  test("the legacy era's spelled-out placeholder is marked too", () => {
    const [, block] = parse([
      { text: "SZEGEDI ÍTÉLŐTÁBLA" },
      { text: "a felperes alperes neve (címe) ellen indított perében" },
    ]).documentAst.blocks;
    const marked =
      block?.type === "paragraph"
        ? block.inlines.flatMap((inline) =>
            inline.type === "text" && inline.anonymized === true
              ? [inline.text]
              : [],
          )
        : [];
    expect(marked).toEqual(["alperes neve"]);
  });
});

// ── End to end, one decision per era ─────────────────────

describe("a decision the publisher served", () => {
  test("the current era's DOCX reads into a sectioned AST", async () => {
    const bytes = await Bun.file(
      new URL("hu-bhgy-decision.docx", FIXTURES_DIR),
    ).arrayBuffer();
    const parsed = parseHuBhgyDecision({
      document: await parseDocx(bytes, {
        detectVariables: false,
        preloadFonts: false,
      }),
      listedCaseNumber: "Gfv.30197/2024/4",
      court: "Kúria",
      sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
      documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/",
      documentId: "eb8acbdd-45e9-467f-b6e4-8f36bbf41046",
      statutes: [],
    });

    const headings = parsed.documentAst.blocks.flatMap((block) =>
      block.type === "heading" ? [block.plainText] : [],
    );
    // The publisher left a stray keystroke in front of this one
    // ("Re     Rendelkező rész"); the section is still cut, and the heading is
    // still printed as the document prints it.
    expect(
      headings.some((heading) => heading.includes("Rendelkező rész")),
    ).toBe(true);
    expect(headings).toContain("Indokolás");
    expect(parsed.documentDocket).toBe("Gfv.VI.30.197/2024/4");
    expect(parsed.decisionType).toBe("végzés");
    expect(parsed.decisionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // Court-numbered paragraphs survive as numbers, not as text prefixes.
    const numbered = parsed.documentAst.blocks.filter(
      (block) => block.type === "paragraph" && block.number !== undefined,
    );
    expect(numbered.length).toBeGreaterThan(5);
    expect(parsed.fulltext).not.toContain("[1]");
    expect(parsed.sections.length).toBeGreaterThan(1);
    expect(parsed.readerWarnings).toEqual([]);
  });

  test("the legacy era's RTF reads into the same shape", async () => {
    const bytes = await Bun.file(
      new URL("hu-bhgy-decision.rtf", FIXTURES_DIR),
    ).bytes();
    const parsed = parseHuBhgyDecision({
      document: readRtf(bytes),
      listedCaseNumber: "Bhar.31/2009/6",
      court: "Győri Ítélőtábla",
      sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
      documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/",
      documentId: "AHK4T__4567565",
      statutes: [],
    });

    expect(parsed.readerWarnings).toEqual([]);
    expect(parsed.documentDocket).toBe("Bhar.31/2009/6");
    expect(parsed.decisionDate).toBe("2009-06-30");
    // The Central-European code page decoded, so the vowels are Hungarian.
    expect(parsed.fulltext).toContain("Győri Ítélőtábla");
    // The legacy era sets its section titles letter by letter; the text keeps
    // the publisher's spacing and the heading is recognised through it.
    expect(parsed.fulltext).toContain("I n d o k o l á s :");
    expect(
      parsed.documentAst.blocks.flatMap((block) =>
        block.type === "heading" && block.level === 1 ? [block.plainText] : [],
      ),
    ).toEqual([
      "Győri Ítélőtábla, mint harmadfokú bíróság",
      "v é g z é s t :",
      "I n d o k o l á s :",
      "Záradék:",
    ]);
  });
});
