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
      readPlKioLayout($);
      const after = withoutSpacing(visibleText($));
      const pages = (html.match(/<hr\b/giu)?.length ?? 0) + 1;

      const omitted = omittedFrom(before, after);
      expect(omitted, id).toBeDefined();
      expect(omitted ?? "", id).toMatch(/^\d*$/u);
      expect((omitted ?? "").length, id).toBeLessThanOrEqual(pages * 3);
    }
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
    // Square and cubic metres: eight set in small type, one as `<sup>`.
    expect(raised.toSorted()).toEqual([
      ...Array.from({ length: 7 }, () => "m^2"),
      "m^3",
      "m^3",
    ]);
    expect(fulltext).toContain("1m3 piachu");
    expect(fulltext).not.toContain("1m 3 piachu");
  });
});
