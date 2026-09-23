/**
 * The Constitutional Tribunal portal's case pages, read from captures.
 *
 * Every fixture is a case page the portal served, gzipped verbatim, with a
 * provenance sidecar; each was picked for a shape the others do not have.
 */

import { describe, expect, test } from "bun:test";

import {
  listPlTkPageFields,
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
  const ruling = readPlTkRuling(await casePage(name), documentId);
  if (ruling === null) {
    throw new Error(`${name} holds no ruling ${documentId}`);
  }
  return ruling;
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
    const page = readPlTkCasePage(await casePage("pl-tk-case-k-2-26.html.gz"));

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
    expect(page?.record.caseDocuments.map(({ url }) => url)).toContain(
      "https://ipo.trybunal.gov.pl/ipo/dok?dok=a6aff75e-4944-4044-9015-b6af062d09c2%2FK_2_26_2026_06_25_transkrypcja.pdf",
    );
  });

  test("a case holding three rulings names every one, with its links to other cases", async () => {
    const page = readPlTkCasePage(
      await casePage("pl-tk-case-sk-14-11.html.gz"),
    );

    expect(page?.rulingIds).toEqual(["9895", "9897", "9896"]);
    expect(page?.record.originatesFrom).toEqual(["Ts 104/11"]);
    expect(page?.record.joinedCases).toEqual(["SK 42/12"]);
  });

  test("a preliminary review names the case it was transferred to", async () => {
    const page = readPlTkCasePage(
      await casePage("pl-tk-case-ts-70-24.html.gz"),
    );

    expect(page?.record.transferredTo).toEqual(["SK 44/26"]);
    expect(page?.record.parties).toEqual([]);
  });

  test("a resolution names the signalling decision issued with it", async () => {
    const page = readPlTkCasePage(await casePage("pl-tk-case-w-3-94.html.gz"));

    expect(page?.record.signalledCase).toEqual(["S 1/94"]);
  });
});

describe("one ruling's tab", () => {
  test("the ruling's own record, not another ruling's in the same case", async () => {
    const html = await casePage("pl-tk-case-sk-14-11.html.gz");
    const judgment = readPlTkRuling(html, "9897");
    const costs = readPlTkRuling(html, "9895");

    expect(judgment?.decisionForm).toBe("Wyrok");
    expect(costs?.decisionForm).toBe("Postanowienie dot. kosztów");
    expect(judgment?.decisionDate).toBe("2013-10-22");
    expect(judgment?.textHtml).not.toBe(costs?.textHtml);
    expect(readPlTkRuling(html, "1")).toBeNull();
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
    expect(ruling.wordDocumentUrl).toBe(
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
    expect(ruling.publications).toEqual([
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
    const ruling = await rulingOf("pl-tk-case-k-44-16.html.gz", "16940");

    expect(ruling.footnotes).toHaveLength(2);
    expect(ruling.footnotes[0]).toStartWith(
      "Sentencja została ogłoszona dnia 5 czerwca 2018 r. w Dzienniku Ustaw poz. 1079 wraz z adnotacją: „Rozstrzygnięcie wydane z naruszeniem przepisów",
    );

    // The portal prints each note twice: in a popup beside its mark, and in
    // the table closing the text. The popup is dropped, the table read.
    const { documentAst } = parsePlTkText({
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
    const ruling = await rulingOf(name, documentId);
    return parsePlTkText({
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
      "1 Zdanie odrębne",
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
      for (const label of listPlTkPageFields(await casePage(name))) {
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
    const ruling = await rulingOf("pl-tk-case-k-2-26.html.gz", "25564");
    const textHtml = ruling.textHtml ?? "";
    const { documentAst } = parsePlTkText({
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
    readPlTkRuling(edit(await casePage("pl-tk-case-k-2-26.html.gz")), "25564")
      ?.courtAsPrinted;

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
});
