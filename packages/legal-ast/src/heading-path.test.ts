import { expect, test } from "bun:test";

import type { Block, HeadingLevel } from "./document-ast";
import {
  headingPathsByAnchor,
  statuteHeadingPathsByAnchor,
} from "./heading-path";
import { isStatuteAst } from "./statute-ast";
import type { StatuteAst } from "./statute-ast";

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

const statute = {
  version: 1,
  source: {
    system: "cz-esbirka",
    eliExpressionUri: null,
    sourceUrl: "https://example.test/statute",
  },
  metadata: {
    naturalId: "252/1997",
    title: "Zákon o zemědělství",
    language: "cs",
    status: "consolidated",
    validFrom: "2026-01-01",
    validTo: null,
  },
  body: [
    {
      type: "paragraph",
      eId: "intro",
      anchorId: "intro",
      inlines: [{ type: "text", text: "Úvod" }],
      plainText: "Úvod",
    },
    {
      type: "provision",
      eId: "cast",
      wId: "cast",
      anchorId: "cast",
      kind: "part",
      num: "ČÁST DRUHÁ",
      heading: [{ type: "text", text: "Přímé platby" }],
      plainText: "ČÁST DRUHÁ\nPřímé platby",
      children: [
        {
          type: "provision",
          eId: "hlava",
          wId: "hlava",
          anchorId: "hlava",
          kind: "chapter",
          num: "HLAVA I",
          heading: null,
          plainText: "HLAVA I",
          children: [
            {
              type: "provision",
              eId: "dil",
              wId: "dil",
              anchorId: "dil",
              kind: "division",
              num: "Díl 1",
              heading: null,
              plainText: "Díl 1",
              children: [
                {
                  type: "provision",
                  eId: "par_5",
                  wId: "par_5",
                  anchorId: "par-5",
                  kind: "paragraph",
                  num: "§ 5",
                  heading: [
                    { type: "text", text: "Žádost o poskytnutí přímé platby" },
                  ],
                  plainText: "§ 5\nŽádost o poskytnutí přímé platby",
                  children: [
                    {
                      type: "paragraph",
                      eId: "p1",
                      anchorId: "p1",
                      inlines: [],
                      plainText: "První odstavec",
                    },
                    {
                      type: "paragraph",
                      eId: "p2",
                      anchorId: "p2",
                      inlines: [],
                      plainText: "Druhý odstavec",
                    },
                    {
                      type: "list",
                      eId: "list",
                      anchorId: "list",
                      ordered: false,
                      items: [
                        {
                          eId: "item",
                          marker: "a)",
                          children: [
                            {
                              type: "paragraph",
                              eId: "item-p",
                              anchorId: "item-p",
                              inlines: [],
                              plainText: "Položka",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: "table",
                      eId: "table",
                      anchorId: "table",
                      rows: [],
                      plainText: "",
                    },
                    {
                      type: "footnote",
                      eId: "note",
                      ref: "1",
                      inlines: [],
                      plainText: "Poznámka",
                    },
                    {
                      type: "edit",
                      op: "ins",
                      effectiveDate: null,
                      inlines: [],
                    },
                  ],
                },
                {
                  type: "provision",
                  eId: "par_6",
                  wId: "par_6",
                  anchorId: "par-6",
                  kind: "paragraph",
                  num: "§ 6",
                  heading: null,
                  plainText: "§ 6",
                  children: [
                    {
                      type: "paragraph",
                      eId: "next-p",
                      anchorId: "next-p",
                      inlines: [],
                      plainText: "Další ustanovení",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "provision",
      eId: "annex",
      wId: "annex",
      anchorId: "annex",
      kind: "annex",
      num: "Příloha 1",
      heading: null,
      plainText: "Příloha 1",
      children: [
        {
          type: "paragraph",
          eId: "annex-p",
          anchorId: "annex-p",
          inlines: [],
          plainText: "Příloha",
        },
      ],
    },
  ],
} satisfies StatuteAst;

test("statute tree paths follow explicit Část Hlava Díl ancestry and sibling boundaries", () => {
  expect(isStatuteAst(statute)).toBe(true);
  const paths = statuteHeadingPathsByAnchor(statute.body);
  const cast = { anchorId: "cast", title: "ČÁST DRUHÁ\nPřímé platby" };
  const hlava = { anchorId: "hlava", title: "HLAVA I" };
  const dil = { anchorId: "dil", title: "Díl 1" };
  const provision = {
    anchorId: "par-5",
    title: "§ 5\nŽádost o poskytnutí přímé platby",
  };
  expect(paths.get("intro")).toEqual([]);
  expect(paths.get("cast")).toEqual([]);
  expect(paths.get("hlava")).toEqual([cast]);
  expect(paths.get("dil")).toEqual([cast, hlava]);
  expect(paths.get("par-5")).toEqual([cast, hlava, dil]);
  expect(paths.get("p1")).toEqual([cast, hlava, dil, provision]);
  for (const anchor of ["p2", "list", "item-p", "table"]) {
    expect(paths.get(anchor)).toBe(paths.get("p1"));
  }
  expect(paths.get("par-6")).toBe(paths.get("par-5"));
  expect(paths.get("next-p")).toEqual([
    cast,
    hlava,
    dil,
    { anchorId: "par-6", title: "§ 6" },
  ]);
  expect(paths.get("annex")).toEqual([]);
  expect(paths.get("annex-p")).toEqual([
    { anchorId: "annex", title: "Příloha 1" },
  ]);
  expect(paths.has("note")).toBe(false);
  expect(statuteHeadingPathsByAnchor([]).size).toBe(0);
  for (const path of paths.values()) {
    expect(Object.isFrozen(path)).toBe(true);
  }
});
