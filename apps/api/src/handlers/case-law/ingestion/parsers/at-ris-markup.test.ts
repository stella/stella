import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import {
  isRisElement,
  readRisContent,
  risContentLoss,
} from "@/api/handlers/case-law/ingestion/parsers/at-ris-markup";

const FIXTURES = [
  "at-ris-bks-gesperrt",
  "at-ris-bvwg-beschluss",
  "at-ris-lvwg-kaernten",
  "at-ris-lvwg-noe",
  "at-ris-ogh-sachwalter",
  "at-ris-ogh-strafsache",
  "at-ris-umse-abstand",
  "at-ris-verg-bva",
  "at-ris-verg-liste",
  "at-ris-vwgh-randnummern",
] as const;

const fixtureXml = async (name: string): Promise<string> =>
  await Bun.file(new URL(`__fixtures__/${name}.xml`, import.meta.url)).text();

const parseXml = (xml: string) =>
  parseRisDecisionXml({
    sourceDocumentId: "doc",
    caseNumber: "1",
    ecli: undefined,
    court: "court",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    xml,
  });

const parseFixture = async (name: string) =>
  parseXml(await fixtureXml(name)).unwrap();

const textOf = (blocks: readonly Block[]): string =>
  blocks.map((block) => block.plainText).join("\n");

const inlineTypes = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => [
    inline.type,
    ...("children" in inline ? inlineTypes(inline.children) : []),
  ]);

const wrapped = (body: string): string =>
  `<risdok><nutzdaten><abschnitt>${body}</abschnitt></nutzdaten></risdok>`;

describe("RIS element vocabulary", () => {
  test.each(FIXTURES)(
    "%s: every element it prints is in the table",
    async (name) => {
      const $ = cheerio.load(await fixtureXml(name), { xml: true });
      const names = new Set(
        $("nutzdaten *")
          .toArray()
          .flatMap((element) => ("name" in element ? [element.name] : [])),
      );
      expect([...names].filter((element) => !isRisElement(element))).toEqual(
        [],
      );
      expect(parseXml(await fixtureXml(name)).unwrap().unknownElements).toEqual(
        [],
      );
    },
  );

  test("an element outside the table still contributes its text and is reported", () => {
    const parsed = parseXml(
      wrapped('<absatz ct="text">vor <neu>mitten</neu> nach</absatz>'),
    ).unwrap();
    expect(parsed.documentAst.blocks.map(({ plainText }) => plainText)).toEqual(
      ["vor mitten nach"],
    );
    expect(parsed.unknownElements).toEqual(["neu"]);
  });
});

describe("RIS markup read as text", () => {
  test("empty character elements print their character", async () => {
    const ogh = textOf(
      (await parseFixture("at-ris-ogh-strafsache")).documentAst.blocks,
    );
    expect(ogh).toContain("Hv 6/11i-39");
    const vwgh = textOf(
      (await parseFixture("at-ris-vwgh-randnummern")).documentAst.blocks,
    );
    expect(vwgh).toContain("Art. 133 Abs. 4 B-VG");
    const noe = textOf(
      (await parseFixture("at-ris-lvwg-noe")).documentAst.blocks,
    );
    expect(noe).toContain("GmbH & Co KG");
    const verg = textOf(
      (await parseFixture("at-ris-verg-bva")).documentAst.blocks,
    );
    expect(verg).toContain("von < 350 bzw.");
    const sachwalter = textOf(
      (await parseFixture("at-ris-ogh-sachwalter")).documentAst.blocks,
    );
    expect(sachwalter).toContain("Einsichts- und Urteilsfähigkeit");
    expect(sachwalter).toContain("Morbus-Down");
  });

  test("a tab after a number keeps the number apart from the text", async () => {
    const blocks = (await parseFixture("at-ris-vwgh-randnummern")).documentAst
      .blocks;
    expect(
      blocks
        .map(({ plainText }) => plainText)
        .filter((text) => /^\d+ [A-Z]/u.test(text)),
    ).toHaveLength(10);
    expect(textOf(blocks)).toContain(
      "1 Mit dem nunmehr angefochtenen Erkenntnis",
    );
  });

  test("a superscript stays a superscript inline", async () => {
    const blocks = (await parseFixture("at-ris-ogh-strafsache")).documentAst
      .blocks;
    const block = blocks.find(({ plainText }) =>
      plainText.includes("WK2 § 201 Rz 3"),
    );
    expect(block?.type).toBe("paragraph");
    expect(block?.type === "paragraph" && inlineTypes(block.inlines)).toContain(
      "superscript",
    );
  });

  test("underline and italic survive as inlines", async () => {
    const blocks = (await parseFixture("at-ris-ogh-sachwalter")).documentAst
      .blocks;
    const types = blocks.flatMap((block) =>
      block.type === "paragraph" ? inlineTypes(block.inlines) : [],
    );
    expect(types).toContain("underline");
    expect(types).toContain("italic");
  });

  test("a list item is a paragraph of its own, label apart from text", async () => {
    const parsed = await parseFixture("at-ris-verg-liste");
    const texts = parsed.documentAst.blocks.map(({ plainText }) => plainText);
    const items = texts.filter((text) => /^\d\. [A-Z]/u.test(text));
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(texts.some((text) => /\d\.[A-Z]/u.test(text))).toBe(false);
  });

  test("a letter-spaced word reads as a word", async () => {
    const texts = (
      await parseFixture("at-ris-bks-gesperrt")
    ).documentAst.blocks.map(({ plainText }) => plainText);
    expect(texts).toContain("BESCHEID");
    expect(texts).not.toContain("B E S C H E I D");
  });

  test("publisher paragraph breaks delimit a transcript's paragraphs", async () => {
    const blocks = (await parseFixture("at-ris-umse-abstand")).documentAst
      .blocks;
    expect(blocks.length).toBeLessThan(600);
    expect(textOf(blocks)).toContain(
      "Es ist eine Bestätigung von einem Zivilingenieur einschlägiger Fachrichtung vorzulegen, dass durch die vorliegende Typenprüfung",
    );
  });

  test("a document of one absatz per paragraph keeps its paragraphs", async () => {
    const blocks = (await parseFixture("at-ris-ogh-sachwalter")).documentAst
      .blocks;
    const xml = await fixtureXml("at-ris-ogh-sachwalter");
    const absaetze = xml.split("<absatz").length - 1;
    // Header and footer each print a few lines; the body is not merged.
    expect(blocks.length).toBeGreaterThan(absaetze / 2);
  });
});

describe("RIS content loss", () => {
  const contentOf = (xml: string) => {
    const $ = cheerio.load(xml, { xml: true });
    const content = $("nutzdaten").first().get(0);
    if (content === undefined) {
      throw new Error("fixture has no nutzdaten");
    }
    return content;
  };

  test.each(FIXTURES)("%s: no printed character is lost", async (name) => {
    const content = contentOf(await fixtureXml(name));
    expect(risContentLoss(content, readRisContent(content).items)).toBe(0);
  });

  test("a dropped item is reported with the characters it carried", () => {
    const content = contentOf(
      wrapped(
        '<absatz ct="text">eins</absatz><absatz ct="text">zwei<gdash/>drei</absatz>',
      ),
    );
    const { items } = readRisContent(content);
    expect(risContentLoss(content, items)).toBe(0);
    expect(risContentLoss(content, items.slice(0, 1))).toBe("zwei-drei".length);
  });

  test("a dropped character element is reported", () => {
    const content = contentOf(wrapped('<absatz ct="text">a<amp/>b</absatz>'));
    const [item] = readRisContent(content).items;
    if (item?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    const withoutAmp = {
      ...item,
      inlines: item.inlines.filter(
        (inline) => !(inline.type === "text" && inline.text === "&"),
      ),
    };
    expect(risContentLoss(content, [withoutAmp])).toBe(1);
  });

  test("a document whose text does not survive is refused", () => {
    expect(parseXml(wrapped("   ")).isErr()).toBe(true);
  });
});
