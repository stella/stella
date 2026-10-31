import { expect, test } from "bun:test";

import statuteFixture from "./__fixtures__/cz-262-2006-section-51.json";
import { parseDocumentAst } from "./document-ast";
import type { Block, HeadingLevel } from "./document-ast";
import { headingPathsByAnchor } from "./heading-path";

const heading = (
  anchorId: string,
  level: HeadingLevel,
  title: string,
): Block => ({
  anchorId,
  id: anchorId,
  type: "heading",
  level,
  plainText: title,
  inlines: [{ type: "text", text: title }],
});
const paragraph = (anchorId: string): Block => ({
  anchorId,
  id: anchorId,
  type: "paragraph",
  plainText: "Wording",
  inlines: [{ type: "text", text: "Wording" }],
});
const part = { anchorId: "part", title: "ČÁST DRUHÁ\nPřímé platby" };
const chapter = { anchorId: "chapter", title: "HLAVA I" };
const division = { anchorId: "division", title: "Díl 1" };
const section = {
  anchorId: "section",
  title: "§ 5\nŽádost o poskytnutí přímé platby",
};

test("heading paths preserve statute division titles and discard completed siblings", () => {
  const paths = headingPathsByAnchor([
    paragraph("intro"),
    heading(part.anchorId, 1, part.title),
    heading(chapter.anchorId, 2, chapter.title),
    heading(division.anchorId, 3, division.title),
    heading(section.anchorId, 4, section.title),
    paragraph("wording"),
    heading("next", 2, "Hlava II"),
    paragraph("next-wording"),
  ]);
  expect(paths.get("intro")).toEqual([]);
  expect(paths.get("part")).toEqual([]);
  expect(paths.get("chapter")).toEqual([part]);
  expect(paths.get("division")).toEqual([part, chapter]);
  expect(paths.get("section")).toEqual([part, chapter, division]);
  expect(paths.get("wording")).toEqual([part, chapter, division, section]);
  expect(paths.get("next")).toEqual([part]);
  expect(paths.get("next-wording")).toEqual([
    part,
    { anchorId: "next", title: "Hlava II" },
  ]);
});

test("decision heading paths follow sparse levels and reset at a dissent", () => {
  const paths = headingPathsByAnchor([
    heading("reasoning", 1, "Odůvodnění"),
    heading("facts", 3, "Skutkový stav"),
    paragraph("facts-wording"),
    heading("law", 3, "Právní posouzení"),
    paragraph("law-wording"),
    heading("dissent", 1, "Odlišné stanovisko"),
    paragraph("dissent-wording"),
  ]);
  const reasoning = { anchorId: "reasoning", title: "Odůvodnění" };
  expect(paths.get("facts")).toEqual([reasoning]);
  expect(paths.get("law-wording")).toEqual([
    reasoning,
    { anchorId: "law", title: "Právní posouzení" },
  ]);
  expect(paths.get("dissent")).toEqual([]);
  expect(paths.get("dissent-wording")).toEqual([
    { anchorId: "dissent", title: "Odlišné stanovisko" },
  ]);
  expect(paths.get("facts-wording")).toEqual([
    reasoning,
    { anchorId: "facts", title: "Skutkový stav" },
  ]);
});

test("heading paths distinguish duplicate titles by anchors at different levels", () => {
  const title = "Odůvodnění";
  const paths = headingPathsByAnchor([
    heading("outer", 1, title),
    heading("inner", 3, title),
    paragraph("wording"),
    heading("sibling", 3, title),
    paragraph("sibling-wording"),
  ]);
  expect(paths.get("inner")).toEqual([{ anchorId: "outer", title }]);
  expect(paths.get("wording")).toEqual([
    { anchorId: "outer", title },
    { anchorId: "inner", title },
  ]);
  expect(paths.get("sibling-wording")).toEqual([
    { anchorId: "outer", title },
    { anchorId: "sibling", title },
  ]);
});

test("heading paths cover every anchor without guessing a hierarchy for plain text", () => {
  const blocks = [paragraph("a"), paragraph("b")];
  const paths = headingPathsByAnchor(blocks);
  expect([...paths.keys()]).toEqual(blocks.map(({ anchorId }) => anchorId));
  expect([...paths.values()]).toEqual([[], []]);
  expect(headingPathsByAnchor([]).size).toBe(0);
});

test("heading paths preserve whitespace and cover table and image anchors", () => {
  const title = "  Odůvodnění\n  Posouzení věci  ";
  const blocks = [
    heading("heading", 1, title),
    { id: "table", anchorId: "table", type: "table", rows: [], plainText: "" },
    {
      id: "image",
      anchorId: "image",
      type: "image",
      src: "/figure.png",
      plainText: "Figure",
    },
  ] as const satisfies readonly Block[];
  const paths = headingPathsByAnchor(blocks);
  expect([...paths.keys()]).toEqual(blocks.map(({ anchorId }) => anchorId));
  expect(paths.get("heading")).toEqual([]);
  for (const block of blocks.slice(1)) {
    expect(paths.get(block.anchorId)).toEqual([{ anchorId: "heading", title }]);
  }
});

test("blocks sharing a heading stack share one frozen path", () => {
  const paths = headingPathsByAnchor([
    paragraph("intro-a"),
    paragraph("intro-b"),
    heading("outer", 1, "Odůvodnění"),
    paragraph("outer-a"),
    paragraph("outer-b"),
    heading("inner", 2, "Posouzení"),
    paragraph("inner-a"),
    paragraph("inner-b"),
    heading("sibling", 2, "Závěr"),
    paragraph("sibling-a"),
    paragraph("sibling-b"),
  ]);
  expect(paths.get("intro-a")).toBe(paths.get("intro-b"));
  expect(paths.get("intro-a")).toBe(paths.get("outer"));
  expect(paths.get("outer-a")).toBe(paths.get("outer-b"));
  expect(paths.get("outer-a")).toBe(paths.get("inner"));
  expect(paths.get("inner-a")).toBe(paths.get("inner-b"));
  expect(paths.get("sibling-a")).toBe(paths.get("sibling-b"));
  expect(paths.get("sibling-a")).not.toBe(paths.get("inner-a"));
  for (const path of paths.values()) {
    expect(Object.isFrozen(path)).toBe(true);
    for (const entry of path) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  }
});

test("parsed statute wording carries the publisher's Část Hlava Díl and provision path", () => {
  const ast = parseDocumentAst(statuteFixture);
  expect(ast).not.toBeNull();
  if (ast === null) {
    throw new Error("Statute document fixture does not parse");
  }
  const wording = ast.blocks.find(
    (block) => block.anchorId === "par_51-odst_1",
  );
  expect(wording?.type).toBe("paragraph");
  expect(wording?.plainText).toStartWith("(1) Byla-li dána výpověď");
  const paths = headingPathsByAnchor(ast.blocks);
  const ancestors = [
    { anchorId: "cast_druha", title: "ČÁST DRUHÁ\nPRACOVNÍ POMĚR" },
    { anchorId: "hlava_iv", title: "HLAVA IV\nSKONČENÍ PRACOVNÍHO POMĚRU" },
    {
      anchorId: "dil_3",
      title: "Díl 3\nVýpověď, výpovědní doba a výpovědní důvody",
    },
    { anchorId: "oddil_1", title: "Oddíl 1\nVýpověď" },
  ];
  expect(paths.get("par_51")).toEqual(ancestors);
  expect(paths.get("par_51-odst_1")).toEqual([
    ...ancestors,
    { anchorId: "par_51", title: "§ 51" },
  ]);
  expect(paths.get("par_51-odst_3")).toBe(paths.get("par_51-odst_1"));
});
