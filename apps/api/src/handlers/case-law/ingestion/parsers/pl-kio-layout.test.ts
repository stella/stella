import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { readPlKioLayout } from "@/api/handlers/case-law/ingestion/parsers/pl-kio-layout";

const FIXTURES_DIR = new URL("../adapters/__fixtures__/", import.meta.url);

const gzFixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES_DIR)).arrayBuffer()),
    ),
  );

/** Every captured procurement document, printed and Word-converted alike. */
const CAPTURED = ["100", "420", "3429", "17000", "36118", "36575"] as const;

const visibleText = ($: cheerio.CheerioAPI): string => $("body").text();

const withoutSpacing = (text: string): string =>
  text.replace(/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");

/**
 * Whether `kept` is `source` with only some of its characters left out, in
 * order, and which ones those were.
 */
const omittedFrom = (source: string, kept: string): string | undefined => {
  let omitted = "";
  let position = 0;
  for (const character of kept) {
    const found = source.indexOf(character, position);
    if (found === -1) {
      return undefined;
    }
    omitted += source.slice(position, found);
    position = found + character.length;
  }
  return omitted + source.slice(position);
};

describe("reading the converter's layout", () => {
  test("it moves spacing and drops page numbers, and never touches another character", async () => {
    for (const id of CAPTURED) {
      const html = await gzFixtureText(`pl-kio-content-${id}.html.gz`);
      const before = withoutSpacing(visibleText(cheerio.load(html)));
      const $ = cheerio.load(html);
      const { pageNumbers } = readPlKioLayout($);
      const after = withoutSpacing(visibleText($));

      // Only the page numbers the reader names went, in order, and they
      // run as a page sequence does.
      expect(omittedFrom(before, after), id).toBe(pageNumbers.join(""));
      const values = pageNumbers.map(Number);
      expect(
        values.every(
          (value, index) => index === 0 || value > (values[index - 1] ?? 0),
        ),
        id,
      ).toBe(true);
    }
  });

  test("a number a citation word claims is no page number", () => {
    // The page breaks between an article and its number; a paged document
    // keeps it because nothing else in the sequence vouches for it.
    const article = cheerio.load(
      "<html><body><p>Zgodnie z art.<br>353</p><hr><p>Kodeksu cywilnego.</p></body></html>",
    );
    expect(readPlKioLayout(article).pageNumbers).toEqual([]);
    expect(visibleText(article)).toContain("353");

    // An annex number ending a document the converter did not page.
    const annex = cheerio.load(
      "<html><body><p>Załącznik nr</p><p>12</p></body></html>",
    );
    expect(readPlKioLayout(annex).pageNumbers).toEqual([]);
    expect(visibleText(annex)).toContain("12");
  });

  test.each([
    {
      name: "an explicit subscript",
      style: "vertical-align:sub",
      expected: "<sub>2</sub>",
    },
    {
      name: "a small number without vertical alignment",
      style: "",
      expected: '<span style="font-size:8pt">2</span>',
    },
    {
      name: "an explicit superscript",
      style: "vertical-align:super",
      expected: "<sup>2</sup>",
    },
  ])("$name keeps its stated index position", ({ style, expected }) => {
    const alignment = style === "" ? "" : `;${style}`;
    const $ = cheerio.load(
      `<body style="font-size:12pt"><p>CO<span style="font-size:8pt${alignment}">2</span></p></body>`,
    );

    readPlKioLayout($);

    expect($("p").html()).toBe(`CO${expected}`);
  });

  test.each([
    { shift: "2pt", expected: "<sup>2</sup>" },
    { shift: "-0.25em", expected: "<sub>2</sub>" },
  ])(
    "an inherited $shift baseline shift sets the index position",
    ({ shift, expected }) => {
      const $ = cheerio.load(
        `<body style="font-size:12pt"><p style="baseline-shift:${shift}">` +
          'CO<span style="font-size:8pt">2</span></p></body>',
      );

      readPlKioLayout($);

      expect($("p").html()).toBe(`CO${expected}`);
    },
  );

  test("an unstyled final number inherits the body typeface", () => {
    const bodyText = cheerio.load(
      '<body style="font-size:12pt"><p>Document text.</p><p>42</p></body>',
    );
    expect(readPlKioLayout(bodyText).pageNumbers).toEqual([]);
    expect(visibleText(bodyText)).toContain("42");

    const footer = cheerio.load(
      '<body style="font-size:12pt"><p>Document text.</p><p style="font-size:8pt">42</p></body>',
    );
    expect(readPlKioLayout(footer).pageNumbers).toEqual(["42"]);
    expect(visibleText(footer)).not.toContain("42");
  });

  test("an unstyled final number inherits the body's font shorthand, size and family alike", () => {
    const shorthand = cheerio.load(
      '<body style="font: 12pt Arial"><p>Koniec.</p><p>12</p></body>',
    );
    expect(readPlKioLayout(shorthand).pageNumbers).toEqual([]);
    expect(visibleText(shorthand)).toContain("12");
  });

  test.each([" / ", " /", "/ ", "/"])(
    "font shorthand parses line-height spacing %j and quoted families",
    (separator) => {
      const sameFamily = cheerio.load(
        `<html><body style="font: italic 12pt${separator}1.2 'Arial Narrow', sans-serif">` +
          `<p>Document text.</p>` +
          `<p style="font: 400 12pt 'Arial Narrow', sans-serif">42</p>` +
          `</body></html>`,
      );
      expect(readPlKioLayout(sameFamily).pageNumbers).toEqual([]);
      expect(visibleText(sameFamily)).toContain("42");

      const differentFamily = cheerio.load(
        `<html><body style="font: italic 12pt${separator}1.2 'Arial Narrow', sans-serif">` +
          `<p>Document text.</p>` +
          `<p style="font: 400 12pt 'Times New Roman', serif">42</p>` +
          `</body></html>`,
      );
      expect(readPlKioLayout(differentFamily).pageNumbers).toEqual(["42"]);
      expect(visibleText(differentFamily)).not.toContain("42");

      const explicitFamilyWins = cheerio.load(
        `<html><body style="font: italic 12pt${separator}1.2 'Times New Roman', serif; ` +
          `font-family: 'Arial Narrow', sans-serif">` +
          `<p>Document text.</p>` +
          `<p style="font: 400 12pt 'Arial Narrow', sans-serif">42</p>` +
          `</body></html>`,
      );
      expect(readPlKioLayout(explicitFamilyWins).pageNumbers).toEqual([]);
      expect(visibleText(explicitFamilyWins)).toContain("42");
    },
  );

  test("fractional bold font weights retain their printed width", () => {
    const textWithWeight = (weight: string): string => {
      const $ = cheerio.load(
        `<body style="font-size:10pt"><p style="padding-left:20pt">` +
          `<span style="font-weight:${weight}">${"W".repeat(20)}</span>` +
          `<br>Aaaa nnnnnn</p><p>${"A".repeat(37)}<br>end</p></body>`,
      );
      readPlKioLayout($);
      return $("p").first().text();
    };
    expect(textWithWeight("600.5")).toBe(textWithWeight("bold"));
    expect(textWithWeight("600.5")).toBe(`${"W".repeat(20)} Aaaa nnnnnn`);
    expect(textWithWeight("400")).toBe(`${"W".repeat(20)}Aaaa nnnnnn`);
  });

  test("paragraph breaks preserve their enclosing inline formatting", () => {
    const $ = cheerio.load(
      "<p><span>Introductory text<br>1. First point<br>2. Second point</span></p>",
    );

    readPlKioLayout($);

    expect($("p").length).toBe(3);
    expect(
      $("p")
        .toArray()
        .map((paragraph) => $(paragraph).text()),
    ).toEqual(["Introductory text", "1. First point", "2. Second point"]);
    expect(
      $("p")
        .toArray()
        .map((paragraph) => $(paragraph).html()),
    ).toEqual([
      "<span>Introductory text</span>",
      "<span>1. First point</span>",
      "<span>2. Second point</span>",
    ]);
  });

  test("a paragraph runs on across a page only when page furniture alone lies between", () => {
    const $ = cheerio.load(
      [
        "<html><body>",
        // The second line is the page's widest, so it reads as full and its
        // sentence as running on past the page break.
        "<p>Wartości<br>zamówienia, zgodnie z kosztorysem przedstawionym przez zamawiającego, wynoszą</p>",
        "<table><tr><td>100 zł</td></tr></table>",
        "<hr>",
        "<p>oraz obejmują podatek.</p>",
        "</body></html>",
      ].join(""),
    );
    readPlKioLayout($);

    const text = withoutSpacing(visibleText($));
    expect(text.indexOf("100zł")).toBeLessThan(text.indexOf("orazobejmują"));
    expect($("p").length).toBe(2);
  });

  test("a long printed ruling reads without its page numbers and with its indices raised", async () => {
    const html = await gzFixtureText("pl-kio-content-420.html.gz");
    const { documentAst, fulltext } = parsePlDecisionContent({
      caseNumber: "KIO 482/16",
      ecli: undefined,
      court: "Krajowa Izba Odwoławcza",
      decisionDate: "2016-04-25",
      decisionType: "wyrok",
      sourceUrl: undefined,
      documentUrl: undefined,
      content: html,
      loadHtml: (source) => {
        const $ = cheerio.load(source);
        readPlKioLayout($);
        return $;
      },
      keywords: [],
      statutes: [],
      documentId: "420",
      superscripts: true,
    });

    // The print's page 31 ends after "Izba wskazuje,".
    expect(fulltext).toContain("Izba wskazuje, że");
    expect(fulltext).not.toMatch(/\n\d{1,3}\n/u);
    const raised = documentAst.blocks.flatMap((block) =>
      block.type === "paragraph"
        ? block.inlines.flatMap((inline, index) => {
            const base = block.inlines[index - 1];
            const [raisedText] =
              inline.type === "superscript" ? inline.children : [];
            return raisedText?.type === "text" && base?.type === "text"
              ? [`${base.text.slice(-1)}^${raisedText.text}`]
              : [];
          })
        : [],
    );
    // Only the square metre explicitly marked as `<sup>` is raised. The
    // converter's small type alone does not establish an index.
    expect(raised).toEqual(["m^2"]);
    expect(fulltext).toContain("1m 3 piachu");
  });
});
