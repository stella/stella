/**
 * The Constitutional Tribunal portal's case pages, read from captures.
 *
 * Every fixture is a case page the portal served, gzipped verbatim, with a
 * provenance sidecar; each was picked for a shape the others do not have.
 */

import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import {
  type Block,
  hasInlineChildren,
  type Inline,
} from "@stll/legal-ast/document-ast";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  listPlTkPageFields,
  parsePlTkPage,
  parsePlTkText,
  parsePolishDate,
  readPlTkCasePage,
  readPlTkRuling,
  validatePlTkBlocks,
} from "@/api/handlers/case-law/ingestion/parsers/pl-tk";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const casePage = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES)).arrayBuffer()),
    ),
  );

const rulingOf = async (name: string, documentId: string) => {
  const { ruling } = await rulingAndPageOf(name, documentId);
  return ruling;
};

const rulingAndPageOf = async (name: string, documentId: string) => {
  const page = parsePlTkPage(await casePage(name));
  const ruling = readPlTkRuling(page, documentId);
  if (ruling === null) {
    throw new Error(`${name} holds no ruling ${documentId}`);
  }
  return { page, ruling };
};

describe("dates as the portal prints them", () => {
  test("a genitive month and a padded day", () => {
    expect(parsePolishDate("25 czerwca 2026")).toBe("2026-06-25");
    expect(parsePolishDate("20 września  1988")).toBe("1988-09-20");
    expect(parsePolishDate("z dnia 1 października 1997 r.")).toBe("1997-10-01");
  });

  test("a month the portal never prints is no date", () => {
    expect(parsePolishDate("25 czerwiec 2026")).toBeUndefined();
    expect(parsePolishDate("")).toBeUndefined();
  });
});

describe("the case record", () => {
  test("a judgment's case: parties, reviewed provisions, standards and filings", async () => {
    const page = readPlTkCasePage(
      parsePlTkPage(await casePage("pl-tk-case-k-2-26.html.gz")),
    );

    expect(page?.rulingIds).toEqual(["25564"]);
    expect(page?.record.caseNumber).toBe("K 2/26");
    expect(page?.record.filedDate).toBe("2026-01-20");
    expect(page?.record.filedStkDate).toBe("2026-01-22");
    expect(page?.record.parties).toEqual([
      "Pierwszy Prezes Sądu Najwyższego - wnioskodawca",
      "Prokurator Generalny - uczestnik postępowania",
      "Sejm Rzeczypospolitej Polskiej - uczestnik postępowania",
    ]);
    expect(page?.record.challengedProvisions.map(({ act }) => act)).toEqual([
      "Ustawa z dnia 8. 12. 2017r. o Sądzie Najwyższym",
      "Ustawa z dnia 25. 07. 2002r. Prawo o ustroju sądów administracyjnych",
      "Ustawa z dnia 27. 07. 2001r. Prawo o ustroju sądów powszechnych",
    ]);
    expect(page?.record.challengedProvisions[0]?.provisions).toContain(
      "art. 111 par. 4",
    );
    expect(page?.record.constitutionalStandards[0]?.provisions).toHaveLength(7);
    expect(page?.record.caseDocuments.map(({ url }) => url)).toEqual(
      expect.arrayContaining([
        "https://ipo.trybunal.gov.pl/ipo/dok?dok=a6aff75e-4944-4044-9015-b6af062d09c2%2FK_2_26_2026_06_25_transkrypcja.pdf",
      ]),
    );
  });

  test("a case holding three rulings names every one, with its links to other cases", async () => {
    const page = readPlTkCasePage(
      parsePlTkPage(await casePage("pl-tk-case-sk-14-11.html.gz")),
    );

    expect(page?.rulingIds).toEqual(["9895", "9897", "9896"]);
    expect(page?.record.originatesFrom).toEqual(["Ts 104/11"]);
    expect(page?.record.joinedCases).toEqual(["SK 42/12"]);
  });

  test("a preliminary review names the case it was transferred to", async () => {
    const page = readPlTkCasePage(
      parsePlTkPage(await casePage("pl-tk-case-ts-70-24.html.gz")),
    );

    expect(page?.record.transferredTo).toEqual(["SK 44/26"]);
    expect(page?.record.parties).toEqual([]);
  });

  test("a resolution names the signalling decision issued with it", async () => {
    const page = readPlTkCasePage(
      parsePlTkPage(await casePage("pl-tk-case-w-3-94.html.gz")),
    );

    expect(page?.record.signalledCase).toEqual(["S 1/94"]);
  });
});

describe("one ruling's tab", () => {
  test("the ruling's own record, not another ruling's in the same case", async () => {
    const html = await casePage("pl-tk-case-sk-14-11.html.gz");
    const parsedPage = parsePlTkPage(html);
    const judgment = readPlTkRuling(parsedPage, "9897");
    const costs = readPlTkRuling(parsedPage, "9895");

    expect(judgment?.decisionForm).toBe("Wyrok");
    expect(costs?.decisionForm).toBe("Postanowienie dot. kosztów");
    expect(judgment?.decisionDate).toBe("2013-10-22");
    expect(judgment?.textHtml).not.toBe(costs?.textHtml);
    expect(readPlTkRuling(parsedPage, "1")).toBeNull();
  });

  test("the bench, its functions and the portal's judge ids", async () => {
    const ruling = await rulingOf("pl-tk-case-k-2-26.html.gz", "25564");

    expect(ruling.panel).toEqual([
      {
        name: "Bartłomiej Sochański",
        judgeId: "670",
        functions: ["przewodniczący"],
      },
      { name: "Stanisław Piotrowicz", judgeId: "652", functions: [] },
      { name: "Bogdan Święczkowski", judgeId: "690", functions: [] },
      { name: "Wojciech Sych", judgeId: "630", functions: ["sprawozdawca"] },
      { name: "Andrzej Zielonacki", judgeId: "570", functions: [] },
    ]);
    expect(ruling).toHaveProperty(
      "wordDocumentUrl",
      "https://ipo.trybunal.gov.pl/ipo/downloadOrzeczenieDoc?dok=124529",
    );
  });

  test("a dissent names its author in the genitive; the bench names them in the nominative", async () => {
    const ruling = await rulingOf("pl-tk-case-k-2-26.html.gz", "25564");

    expect(ruling.dissents).toEqual([
      {
        authorsAsPrinted: "sędziego TK Andrzeja Zielonackiego",
        judges: ["Andrzej Zielonacki"],
      },
    ]);
  });

  test("every publication line, with the register links beside a journal entry", async () => {
    const ruling = await rulingOf("pl-tk-case-k-44-16.html.gz", "16940");

    expect(ruling.decisionForm).toBe("Rozstrzygnięcie");
    expect(ruling).toHaveProperty("publications", [
      {
        text: "OTK ZU A/2018, poz. 33",
        links: [
          {
            text: "OTK ZU A/2018, poz. 33",
            url: "https://otkzu.trybunal.gov.pl/2018/A/33",
          },
        ],
      },
      {
        text: "Dz.U. z 2018 r. poz. 1079 z dnia 5 czerwca 2018 r.",
        links: [
          {
            text: "ISAP",
            url: "https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180001079",
          },
          { text: "RCL", url: "http://www.dziennikustaw.gov.pl/DU/2018/1079" },
        ],
      },
    ]);
  });

  test("the publication annotation is read as a footnote, and printed once in the text", async () => {
    const { page, ruling } = await rulingAndPageOf(
      "pl-tk-case-k-44-16.html.gz",
      "16940",
    );

    expect(ruling.footnotes).toHaveLength(2);
    expect(ruling.footnotes[0]).toStartWith(
      "Sentencja została ogłoszona dnia 5 czerwca 2018 r. w Dzienniku Ustaw poz. 1079 wraz z adnotacją: „Rozstrzygnięcie wydane z naruszeniem przepisów",
    );

    // The portal prints each note twice: in a popup beside its mark, and in
    // the table closing the text. The popup is dropped, the table read.
    const { documentAst } = parsePlTkText({
      page,
      caseNumber: "K 44/16",
      court: "Trybunał Konstytucyjny",
      decisionDate: ruling.decisionDate,
      decisionType: "rozstrzygnięcie",
      documentId: "16940",
      sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
      documentUrl: undefined,
      textHtml: ruling.textHtml ?? "",
    });
    const annotated = documentAst.blocks.filter((block) =>
      block.plainText.includes("wraz z adnotacją"),
    );
    expect(annotated).toHaveLength(1);
    expect(annotated[0]?.type === "paragraph" && annotated[0].note).toEqual({
      type: "footnote",
      label: "*",
      noteId: "przypis0-16940",
    });
  });
});

describe("the ruling's text as blocks", () => {
  const blocksOf = async (name: string, documentId: string) => {
    const { page, ruling } = await rulingAndPageOf(name, documentId);
    return parsePlTkText({
      page,
      caseNumber: "K 2/26",
      court: "Trybunał Konstytucyjny",
      decisionDate: ruling.decisionDate,
      decisionType: "wyrok",
      documentId,
      sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
      documentUrl: undefined,
      textHtml: ruling.textHtml ?? "",
    });
  };

  test("the parts of a judgment, from the portal's own containers", async () => {
    const { documentAst } = await blocksOf(
      "pl-tk-case-k-2-26.html.gz",
      "25564",
    );
    const headings = documentAst.blocks.flatMap((block) =>
      block.type === "heading" ? [`${block.level} ${block.plainText}`] : [],
    );

    expect(headings).toEqual([
      "1 WYROK",
      "2 orzeka:",
      "1 Uzasadnienie",
      "2 I",
      "2 II",
      "2 III",
      // The heading prints `Zdanie odrębne`; the next line names the author.
      "1 Zdanie odrębne sędziego TK Andrzeja Zielonackiego",
    ]);
    const roleOf = (text: string): string | undefined =>
      documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" && block.plainText.startsWith(text)
          ? [block.role]
          : [],
      )[0];
    expect(roleOf("83/A/2026")).toBe("front-matter");
    expect(roleOf("Sygn. akt K 2/26")).toBe("case-number");
    expect(roleOf("Bartłomiej Sochański - przewodniczący")).toBe("panel");
    expect(roleOf("umorzyć postępowanie w pozostałym zakresie")).toBe(
      "holding",
    );
    expect(roleOf("Z powyższych przyczyn zdecydowałem się")).toBe("dissent");
  });

  test("a paragraph keeps the Tribunal's running number and not as text", async () => {
    const { documentAst } = await blocksOf(
      "pl-tk-case-k-2-26.html.gz",
      "25564",
    );
    const first = documentAst.blocks.find(
      (block) => block.type === "paragraph" && block.number === 1,
    );

    expect(first?.plainText).toStartWith(
      "1. 20 stycznia 2026 r. Pierwszy Prezes Sądu Najwyższego",
    );
    const dissentAuthor = documentAst.blocks.find(
      (block) =>
        block.type === "paragraph" &&
        block.plainText === "sędziego TK Andrzeja Zielonackiego",
    );
    expect(dissentAuthor?.type === "paragraph" && dissentAuthor.number).toBe(
      236,
    );
  });

  test("emphasis inside a paragraph does not split it", async () => {
    const { documentAst } = await blocksOf(
      "pl-tk-case-k-2-26.html.gz",
      "25564",
    );
    const holding = documentAst.blocks.find(
      (block) =>
        block.type === "paragraph" &&
        block.plainText.startsWith(
          "1. Art. 13 § 3 ustawy z dnia 8 grudnia 2017 r.",
        ),
    );

    // Bold statute and plain citation alternate in the source's markup.
    expect(holding?.plainText).toContain(
      "(Dz. U. z 2024 r. poz. 622) w zakresie",
    );
  });
});

describe("the labels a case page states", () => {
  test("record labels, panel titles and table headers, across every capture", async () => {
    const labels = new Set<string>();
    for (const name of [
      "pl-tk-case-k-2-26.html.gz",
      "pl-tk-case-k-44-16.html.gz",
      "pl-tk-case-sk-14-11.html.gz",
      "pl-tk-case-ts-70-24.html.gz",
      "pl-tk-case-u-1-86.html.gz",
      "pl-tk-case-w-3-94.html.gz",
    ]) {
      for (const label of listPlTkPageFields(
        parsePlTkPage(await casePage(name)),
      )) {
        labels.add(label);
      }
    }

    expect([...labels].toSorted()).toEqual(
      [
        "Data",
        "Data wpływu do STK",
        "Data wpływu do TK",
        "Dokumenty w sprawie",
        "Dotyczy",
        "Miejsce publikacji",
        "Pochodzi z",
        "Podmiot w sprawie",
        "Przeniesiona do",
        "Przedmiot sprawy",
        "Rodzaj orzeczenia",
        "Skład",
        "Sprawy dołączone",
        "Sygnalizacja w sprawie",
        "Sygnatura",
        "Wzorce",
      ].toSorted(),
    );
  });
});

describe("what the portal's markup states beyond the words", () => {
  const judgmentBlocks = async () => {
    const { page, ruling } = await rulingAndPageOf(
      "pl-tk-case-k-2-26.html.gz",
      "25564",
    );
    const textHtml = ruling.textHtml ?? "";
    const { documentAst } = parsePlTkText({
      page,
      caseNumber: "K 2/26",
      court: "Trybunał Konstytucyjny",
      decisionDate: ruling.decisionDate,
      decisionType: "wyrok",
      documentId: "25564",
      sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
      documentUrl: undefined,
      textHtml,
    });
    return { textHtml, blocks: documentAst.blocks };
  };

  test("emphasis set by the portal's classes survives as bold and italic", async () => {
    const { blocks } = await judgmentBlocks();
    const holding = blocks.find(
      (block) =>
        block.type === "paragraph" &&
        block.plainText.startsWith("1. Art. 13 § 3 ustawy"),
    );
    const lead = holding?.type === "paragraph" ? holding.inlines[0] : undefined;

    // `<font class="wyrok_wytluszczenie">` around the reviewed provision.
    expect(lead?.type).toBe("bold");
    const serialized = JSON.stringify(blocks);
    // `<font class="wyrok_kursywa">` around Latin phrases in the reasons.
    expect(serialized).toContain('"type":"italic"');
  });

  test("the text is checked against the portal's markup, so dropped text is caught", async () => {
    const { textHtml, blocks } = await judgmentBlocks();

    const whole = validatePlTkBlocks("K 2/26", textHtml, blocks);
    const truncated = validatePlTkBlocks(
      "K 2/26",
      textHtml,
      blocks.slice(0, 40),
    );

    expect(whole.issues.map((issue) => issue.code)).not.toContain(
      "CONTENT_LOSS",
    );
    expect(truncated.issues.map((issue) => issue.code)).toContain(
      "CONTENT_LOSS",
    );
  });
});

describe("the court a ruling names", () => {
  const judgmentWith = async (
    edit: (html: string) => string,
  ): Promise<string | undefined> =>
    readPlTkRuling(
      parsePlTkPage(edit(await casePage("pl-tk-case-k-2-26.html.gz"))),
      "25564",
    )?.courtAsPrinted;

  test("a full bench is the same court", async () => {
    expect(
      await judgmentWith((html) =>
        html.replace(
          "Trybunał  Konstytucyjny w składzie:",
          "Trybunał Konstytucyjny w pełnym składzie:",
        ),
      ),
    ).toBe("Trybunał Konstytucyjny");
  });

  test("another court's bench cited in the reasons is not the deciding court", async () => {
    const court = await judgmentWith((html) =>
      html
        .replace("Trybunał  Konstytucyjny w składzie:", "Skład:")
        .replace(
          '<p class="wyrok_uzasadnienie_tytul">Uzasadnienie</p>',
          '<p class="wyrok_uzasadnienie_tytul">Uzasadnienie</p><p>Sąd Najwyższy w składzie siedmiu sędziów podjął uchwałę.</p>',
        ),
    );

    expect(court).toBeUndefined();
  });

  test("a reasons section nested in a front wrapper cannot name the deciding court", () => {
    const page = parsePlTkPage(`<div id="sprawaForm:tabView">
      <div id="sprawaForm:tabView:dok_1">
        <div id="tekst_1"><div class="document-wrapper">
          <p>Wprowadzenie do orzeczenia</p>
          <section><div class="wyrok_uzasadnienie">
            <p>Sąd Najwyższy w składzie siedmiu sędziów</p>
          </div></section>
        </div></div>
      </div>
    </div>`);

    expect(readPlTkRuling(page, "1")?.courtAsPrinted).toBeUndefined();
  });
});

for (const href of [
  "/ipo/dok?dok=F 1.pdf",
  "/ipo/dok?dok=F:1.pdf",
  "",
  "   ",
  ["javascript", "alert(1)"].join(":"),
]) {
  test(`portal document links retain known-base resolution or whole-entry omission: ${href}`, async () => {
    const $ = cheerio.load(await casePage("pl-tk-case-k-2-26.html.gz"));
    const documents = $('[id="sprawaForm:tabView:dokumentyWSprawie"]');
    documents.empty().append("<ul><li><a>Document</a></li></ul>");
    documents.find("a").attr("href", href);
    const page = readPlTkCasePage(parsePlTkPage($.html()));
    expect(page).not.toBeNull();
    expect(page?.record).toHaveProperty(
      "caseDocuments",
      href.startsWith("/")
        ? [
            {
              text: "Document",
              url: new URL(href, "https://ipo.trybunal.gov.pl/ipo/").href,
            },
          ]
        : [],
    );
  });
}

test("excludes script and style from ruling metadata", () => {
  const ruling = readPlTkRuling(
    parsePlTkPage(`<div id="sprawaForm:tabView:dok_1">
    <div class="prop"><div class="name">Dotyczy<script>bad-label</script></div><div class="value">Visible<style>bad-value</style> subject</div></div>
    <div class="prop"><div class="name">Miejsce publikacji</div><div class="value"><table><tr><td><table><tr><td>Dz.U.<script>bad-citation</script> 2026</td><td>other register</td></tr></table></td><td><a href="https://example.org">ISAP<style>bad-link</style></a></td></tr></table></div></div>
    <div id="tekst_1"><p>Visible decision<script>bad-script</script><style>bad-style</style></p></div>
  </div>`),
    "1",
  );
  expect(ruling?.textHtml).toBe("<p>Visible decision</p>");
  expect(ruling?.subject).toBe("Visible subject");
  expect(ruling?.publications).toHaveLength(1);
  const publication = ruling?.publications.at(0);
  expect(publication?.text).toBe("Dz.U. 2026");
  expect(publication?.links).toHaveLength(1);
  expect(publication?.links.at(0)?.text).toBe("ISAP");
  const url = publication?.links.at(0)?.url;
  // A defect object is not a string and fails the comparison.
  expect(typeof url === "string" && url === "https://example.org/").toBe(true);
});

/** Every ruling of a capture, read and built the way ingestion builds it. */
const everyRuling = async (name: string) => {
  const page = parsePlTkPage(await casePage(name));
  const record = readPlTkCasePage(page);
  if (record === null) {
    throw new Error(`${name} is not a case page`);
  }
  return record.rulingIds.flatMap((documentId) => {
    const ruling = readPlTkRuling(page, documentId);
    if (ruling?.textHtml === undefined) {
      return [];
    }
    const { documentAst } = parsePlTkText({
      page,
      caseNumber: record.record.caseNumber ?? documentId,
      court: "Trybunał Konstytucyjny",
      decisionDate: ruling.decisionDate,
      decisionType: ruling.decisionForm,
      documentId,
      sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
      documentUrl: undefined,
      textHtml: ruling.textHtml,
    });
    return [{ documentId, ruling, blocks: documentAst.blocks }];
  });
};

const textLeaves = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => {
    if (inline.type === "text") {
      return [inline.text];
    }
    return hasInlineChildren(inline) ? textLeaves(inline.children) : [];
  });

const linksIn = (inline: Inline): Inline[] => {
  if (inline.type === "link") {
    return [inline];
  }
  return hasInlineChildren(inline) ? inline.children.flatMap(linksIn) : [];
};

const inlinesOf = (block: Block | undefined): Inline[] =>
  block?.type === "paragraph" || block?.type === "heading" ? block.inlines : [];

/** The text before and after the first inline of `type`, and that inline. */
const aroundFirst = (inlines: readonly Inline[], type: Inline["type"]) => {
  const at = inlines.findIndex((inline) => inline.type === type);
  return at === -1
    ? undefined
    : {
        before: textLeaves(inlines.slice(0, at)).join(""),
        found: inlines[at],
        after: textLeaves(inlines.slice(at + 1)).join(""),
      };
};

describe("the portal's typesetting, read as a browser lays it out", () => {
  // A word, the export's line break and indentation, a word.
  const HARD_WRAP = /\S\n[ \t]+\S/u;
  const SOURCE_WHITESPACE = /[\t\n\r\f]| {2}/u;

  test("the export's line wrapping and indentation never reach a block's text", async () => {
    const names = (
      await Array.fromAsync(
        new Bun.Glob("pl-tk-case-*.html.gz").scan({ cwd: FIXTURES.pathname }),
      )
    ).toSorted();
    const offenders: string[] = [];
    let wrappedRulings = 0;
    for (const name of names) {
      for (const { documentId, ruling, blocks } of await everyRuling(name)) {
        if (HARD_WRAP.test(ruling.textHtml ?? "")) {
          wrappedRulings += 1;
        }
        for (const block of blocks) {
          const leaves = textLeaves(inlinesOf(block));
          if (leaves.some((leaf) => SOURCE_WHITESPACE.test(leaf))) {
            offenders.push(`${name} ${documentId} ${block.anchorId}`);
          }
        }
      }
    }

    // The captures carry the export's hard wrapping, so the check reaches it.
    expect(wrappedRulings).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test(
    "pl-tk.hard-wrapped-paragraph-reads-as-its-words",
    () => {
      const word = fc.stringMatching(/^[a-ząćęłńóśźż0-9.,()§]{1,8}$/u);
      const gap = fc.oneof(
        fc.constant(" "),
        fc
          .integer({ min: 0, max: 24 })
          .map((width) => `\n${" ".repeat(width)}`),
      );
      assertProperty(
        "pl-tk.hard-wrapped-paragraph-reads-as-its-words",
        fc.property(
          fc.array(fc.tuple(word, gap, fc.boolean()), {
            minLength: 1,
            maxLength: 30,
          }),
          (runs) => {
            const body = runs
              .map(([text, separator, italic], index) => {
                const run = italic
                  ? `<font class="wyrok_kursywa">${text}</font>`
                  : text;
                return index === 0 ? run : `${separator}${run}`;
              })
              .join("");
            const page = parsePlTkPage(`<div id="sprawaForm:tabView:dok_1">
              <div id="tekst_1"><div class="wyrok_akapitCaly">
                <div class="wyrok_akapitNr"><a name="akapit1">1</a></div>
                <div class="wyrok_akapitNumerowany">
                  ${body}
                </div>
              </div></div>
            </div>`);
            const ruling = readPlTkRuling(page, "1");
            const { documentAst } = parsePlTkText({
              page,
              caseNumber: "K 1/26",
              court: "Trybunał Konstytucyjny",
              decisionDate: undefined,
              decisionType: undefined,
              documentId: "1",
              sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
              documentUrl: undefined,
              textHtml: ruling?.textHtml ?? "",
            });
            const words = runs.map(([text]) => text).join(" ");
            const [paragraph] = documentAst.blocks;

            expect(paragraph?.plainText).toBe(words);
            expect(textLeaves(inlinesOf(paragraph)).join("")).toBe(words);
          },
        ),
        { numRuns: 200, seed: 69_000_001 },
      );
    },
    propertyTestTimeout(30_000),
  );

  test("a raised number stays on the word it belongs to", async () => {
    const judgment = (await everyRuling("pl-tk-case-sk-14-11.html.gz")).find(
      (ruling) => ruling.documentId === "9897",
    );
    const cited = judgment?.blocks.find((block) =>
      block.plainText.startsWith("2.4. W myśl art. 767"),
    );
    const around = aroundFirst(inlinesOf(cited), "superscript");

    expect(around?.before).toBe("2.4. W myśl art. 767");
    expect(around?.found).toEqual({
      type: "superscript",
      children: [{ type: "text", text: "4" }],
    });
    expect(around?.after).toStartWith(" § 1 k.p.c.");
  });

  test("a raised number the export indents inside its own run still closes up", async () => {
    const [judgment] = await everyRuling("pl-tk-case-sk-68-25.html.gz");
    const quoted = judgment?.blocks.find(
      (block) => block.type === "paragraph" && block.number === 170,
    );
    const around = aroundFirst(
      inlinesOf(quoted).flatMap((inline) =>
        inline.type === "italic" ? inline.children : [inline],
      ),
      "superscript",
    );

    // `(§ 2</font> <font> <font class="wyrok_indeks_gorny">1</font> </font>).`
    expect(around?.before).toEndWith("stosuje się odpowiednio (§ 2");
    expect(around?.found).toEqual({
      type: "superscript",
      children: [{ type: "text", text: "1" }],
    });
    expect(around?.after).toStartWith("). Jeżeli powód");
  });

  test("a footnote mark in the text links to the note the closing table prints", async () => {
    for (const [name, documentId, mark] of [
      ["pl-tk-case-k-24-04.html.gz", "238", "*"],
      ["pl-tk-case-k-44-16.html.gz", "16940", "1"],
    ] as const) {
      const ruling = (await everyRuling(name)).find(
        (candidate) => candidate.documentId === documentId,
      );
      const reference = (ruling?.blocks ?? [])
        .flatMap((block) => inlinesOf(block).flatMap(linksIn))
        .find(
          (link) =>
            link.type === "link" && textLeaves(link.children).join("") === mark,
        );
      const href = reference?.type === "link" ? reference.href : "";
      const note = ruling?.blocks.find(
        (block) => `#${block.anchorId}` === href,
      );

      expect(href).toStartWith("#tresc-przypisu-");
      expect(note?.type === "paragraph" && note.note).toMatchObject({
        type: "footnote",
        label: mark,
      });
    }
  });
});

describe("dissenting opinions", () => {
  test("each dissent's heading names its authors, wherever the Tribunal prints them", async () => {
    const [judgment] = await everyRuling("pl-tk-case-k-24-04.html.gz");
    const dissentHeadings = (judgment?.blocks ?? []).flatMap((block) =>
      block.type === "heading" && block.plainText.startsWith("Zdanie odrębne")
        ? [block.plainText]
        : [],
    );

    expect(dissentHeadings).toEqual([
      "Zdanie odrębne Sędziego TK Jerzego Ciemniewskiego",
      "Zdanie odrębne sędzi TK Ewy Łętowskiej",
      // Printed with the name in the heading itself.
      "Zdanie odrębne sędziego TK Janusza Niemcewicza",
    ]);
    // The author line keeps the Tribunal's running number.
    const authorLine = judgment?.blocks.find(
      (block) => block.plainText === "sędzi TK Ewy Łętowskiej",
    );
    expect(authorLine?.type === "paragraph" && authorLine.number).toBe(66);
  });

  test("the line naming the ruling is never read as a dissent's author", async () => {
    const ruling = await rulingOf("pl-tk-case-k-24-04.html.gz", "238");

    expect(ruling.dissents).toEqual([
      {
        authorsAsPrinted: "Sędziego TK Jerzego Ciemniewskiego",
        judges: ["Jerzy Ciemniewski"],
      },
      {
        authorsAsPrinted: "sędzi TK Ewy Łętowskiej",
        judges: ["Ewa Łętowska"],
      },
      {
        authorsAsPrinted: "sędziego TK Janusza Niemcewicza",
        judges: ["Janusz Niemcewicz"],
      },
    ]);
  });
});
