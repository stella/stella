import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { readdir } from "node:fs/promises";
import * as v from "valibot";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { LINE_WRAP_TYPE, planBlockLineWrap } from "@stll/legal-ast/line-wrap";

import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import { readRtfString } from "@/api/lib/legal-search/parsers/rtf-reader";
import {
  buildValidationHtml,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

import {
  parseUsDecisionHtml as uncheckedParseUsDecisionHtml,
  usDocumentLinesOf,
} from "./cz-us";

const parseUsDecisionHtml = guardParser(uncheckedParseUsDecisionHtml);

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const SNAPSHOT = new URL(
  "__snapshots__/cz-us-parser-output.snapshot.json.gz",
  import.meta.url,
);
const snapshotSchema = v.record(v.string(), v.string());

const fixtureNames = async (): Promise<string[]> =>
  (await readdir(FIXTURES.pathname))
    .filter((name) => /^cz-us-.*\.html\.gz$/u.test(name))
    .toSorted();

const gunzipText = async (url: URL): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await Bun.file(url).arrayBuffer())),
  );

const inputFor = (name: string, html: string) => ({
  html,
  caseNumber: name.slice("cz-us-".length, -".html.gz".length),
  ecli: undefined,
  court: "Ústavní soud",
  decisionDate: undefined,
  decisionType: undefined,
});

const parsedFixture = async (name: string) =>
  parseUsDecisionHtml(
    inputFor(name, await gunzipText(new URL(name, FIXTURES))),
  );

const bodyParagraphs = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter(
    (block): block is ParagraphBlock =>
      block.type === "paragraph" && block.note === undefined,
  );

const headings = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) =>
    block.type === "heading" ? [block.plainText] : [],
  );

/** Text the court never printed: a letter on its own between spaces, run on. */
const LETTER_SPACED_RE = /(?:^|\s)(?:\p{L} ){3,}\p{L}(?=\s|$|[.,:;])/u;

describe("CZ ÚS decisions as the court numbered and set them", () => {
  test.each([
    ["cz-us-ii-us-1966-18.html.gz", 25],
    ["cz-us-iii-us-3031-24.html.gz", 43],
    // The opening sentence ends in "takto:", so the ruling items before
    // paragraph 1 are holdings rather than a lead-in to the numbering.
    ["cz-us-pl-us-52-23.html.gz", 113],
  ])("%s carries the court's paragraph numbers 1 to %d", async (name, last) => {
    const { documentAst } = await parsedFixture(name);
    const numbered = bodyParagraphs(documentAst.blocks).filter(
      (block) => block.number !== undefined,
    );

    expect(numbered.map((block) => block.number)).toEqual(
      Array.from({ length: last }, (_, index) => index + 1),
    );
    for (const block of numbered) {
      expect(block.plainText).not.toMatch(/^\d+\.\s/u);
    }
  });

  test("the ruling after an opening sentence ending in takto: is the holding", async () => {
    const { documentAst } = await parsedFixture("cz-us-pl-us-52-23.html.gz");

    expect(
      documentAst.blocks
        .filter(
          (block) => block.type === "paragraph" && block.role === "holding",
        )
        .map((block) => block.plainText.slice(0, 4)),
    ).toEqual(["I. Z", "II. ", "III.", "IV. "]);
  });

  test.each([
    [
      "cz-us-pl-us-36-93.html.gz",
      [
        /^1\. STANOVISKO soudců Ústavního soudu České republiky JUDr\. P\. H\., JUDr\. V\.J\. a JUDr\. V\.Š\., /u,
        /^2\. STANOVISKO soudce Ústavního soudu JUDr\. P\.V\. k nálezu /u,
      ],
    ],
    [
      "cz-us-pl-us-42-2000.html.gz",
      [
        /^Odlišné stanovisko soudkyně JUDr\. I\. J\. k výrokové části$/u,
        /^Odlišné stanovisko soudců JUDr\. Z\. K\., JUDr\. V\. G\. k výroku nálezu/u,
        /^Odlišné stanovisko soudce JUDr\. J\. M\.$/u,
        /^Odlišné stanovisko soudce JUDr\. P\. V\. k nálezu Pl\.ÚS 42\/2000/u,
        /^Odlišné stanovisko soudce JUDr\. A\. P\. k ústavnosti § 49/u,
        /^Odlišné stanovisko$/u,
        /^Odlišné stanovisko$/u,
      ],
    ],
    [
      "cz-us-pl-us-52-23.html.gz",
      [
        /^1\. Odlišné stanovisko soudce Josefa Fialy /u,
        /^2\. Odlišné stanovisko soudce Milana Hulmáka$/u,
      ],
    ],
    [
      "cz-us-iii-us-3031-24.html.gz",
      [/^Odlišné stanovisko soudkyně Lucie Dolanské Bányaiové$/u],
    ],
  ])("%s heads each separate opinion as printed", async (name, expected) => {
    const { documentAst } = await parsedFixture(name);
    const opinions = documentAst.blocks.filter(
      (block) =>
        block.type === "heading" &&
        block.role === "section-heading" &&
        /stanovisk/iu.test(block.plainText),
    );

    expect(opinions).toHaveLength(expected.length);
    for (const [index, pattern] of expected.entries()) {
      expect(opinions[index]?.plainText).toMatch(pattern);
    }
  });

  test("a sentence of an opinion that names it is not its heading", async () => {
    const { documentAst } = await parsedFixture("cz-us-pl-us-42-2000.html.gz");

    expect(headings(documentAst.blocks)).not.toContain(
      "Odlišné stanovisko odůvodňuji takto:",
    );
    expect(
      bodyParagraphs(documentAst.blocks).find(
        (block) => block.plainText === "Odlišné stanovisko odůvodňuji takto:",
      )?.role,
    ).toBe("dissent");
  });

  test.each([
    ["cz-us-pl-us-36-93.html.gz", 100],
    ["cz-us-pl-us-42-2000.html.gz", 200],
    ["cz-us-i-us-549-2000.html.gz", 40],
    ["cz-us-i-us-2-93.html.gz", 60],
  ])(
    "%s reads its typescript as paragraphs, not printed lines",
    async (name, most) => {
      const { documentAst } = await parsedFixture(name);
      const paragraphs = bodyParagraphs(documentAst.blocks);

      // Line by line, these decisions are 218 to 1400 paragraphs.
      expect(paragraphs.length).toBeLessThan(most);
      for (const block of paragraphs) {
        // No justification padding, no word cut at the margin.
        expect(block.plainText).not.toMatch(/ {2}/u);
        expect(block.plainText).not.toMatch(
          /\p{Ll}- (?!(?:a|i|nebo|anebo|či|až|ani)\s)\p{Ll}/u,
        );
      }
    },
  );

  test("keeps dates the margin broke in the sentence they belong to", async () => {
    const { fulltext } = await parsedFixture("cz-us-i-us-549-2000.html.gz");

    expect(fulltext).toContain("dohodou ze dne 7. 10. 1991 M. S. darovala");
    expect(fulltext).toContain("ve výpovědi ze dne 1. 7. 1999 výslovně uznal");
    expect(fulltext).toContain(
      "Rozsudek Městského soudu v Praze ze dne 12. 5. 2000, sp. zn. 18 Co 140/2000, se zrušuje.",
    );

    const opening = await parsedFixture("cz-us-i-us-2-93.html.gz");
    expect(opening.fulltext).toContain(
      "o ústavní stížnosti ze dne 10. 7. 1992 a 15. 9. 1992 proti rozsudku",
    );
  });

  test("joins a word the margin hyphenated", async () => {
    const { fulltext } = await parsedFixture("cz-us-pl-us-36-93.html.gz");

    expect(fulltext).toContain("s Úmluvou č. 111 o diskriminaci v zaměstnání");
    expect(fulltext).toContain("jen za stanovených podmínek");
    expect(fulltext).not.toContain("dis-");
  });

  test.each([
    ["cz-us-pl-us-36-93.html.gz", "Návrh se zamítá."],
    ["cz-us-i-us-2-93.html.gz", "Ústavní stížnost se zamítá."],
  ])("%s reads the letter-spaced ruling as words", async (name, ruling) => {
    const { documentAst } = await parsedFixture(name);

    expect(
      documentAst.blocks.find(
        (block) => block.type === "paragraph" && block.role === "holding",
      )?.plainText,
    ).toBe(ruling);
  });

  test("leaves nothing for the display joiner of unreparsed rows to join", async () => {
    for (const name of await fixtureNames()) {
      const { documentAst } = await parsedFixture(name);

      expect(
        planBlockLineWrap(documentAst.blocks).classification,
        name,
      ).toEqual({ type: LINE_WRAP_TYPE.UNWRAPPED });
    }
  });

  test("leaves no letter-spaced text, markup or sentence headings", async () => {
    for (const name of await fixtureNames()) {
      const { documentAst, fulltext } = await parsedFixture(name);

      expect(fulltext, name).not.toMatch(LETTER_SPACED_RE);
      expect(fulltext, name).not.toMatch(/\\[a-zA-Z]/u);
      expect(fulltext, name).not.toMatch(/[0-9a-fA-F]{32,}/u);
      expect(markupResidueIn(fulltext), name).toBeUndefined();
      for (const heading of headings(documentAst.blocks)) {
        // A heading is a title, never a sentence cut off at a line end or
        // one opening with an ordinal ("II. senát Ústavního soudu …").
        expect(heading, name).not.toMatch(/[,;-]$/u);
        expect(heading, name).not.toMatch(/^[IVX]+\.\s+\p{Ll}{2}/u);
      }
    }
  });
});

describe("committed CZ ÚS fixtures", () => {
  test("retain their complete serialized parser output", async () => {
    const names = await fixtureNames();
    const snapshotJson: unknown = JSON.parse(await gunzipText(SNAPSHOT));
    const snapshots = v.parse(snapshotSchema, snapshotJson);

    expect(Object.keys(snapshots).toSorted()).toEqual(names);
    for (const name of names) {
      const html = await gunzipText(new URL(name, FIXTURES));
      const snapshot = snapshots[name];
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) {
        throw new Error(`Missing parser snapshot for ${name}`);
      }
      expect(JSON.stringify(parseUsDecisionHtml(inputFor(name, html)))).toBe(
        snapshot,
      );
    }
  });

  test("produce identical diagnostics from paragraphs and validation HTML", async () => {
    for (const name of await fixtureNames()) {
      const html = await gunzipText(new URL(name, FIXTURES));
      const $ = cheerio.load(html);
      const rtf = $("input#docContentHidden").attr("value") ?? "";
      expect(rtf.trim()).not.toBe("");

      const paragraphs = usDocumentLinesOf(readRtfString(rtf)).map((line) =>
        line.kind === "body" ? line.value.plainText : line.note.value.plainText,
      );
      const blocks = parseUsDecisionHtml(inputFor(name, html)).documentAst
        .blocks;

      expect(validateAst({ type: "paragraphs", paragraphs }, blocks)).toEqual(
        validateAst(buildValidationHtml(paragraphs), blocks),
      );
    }
  });
});
