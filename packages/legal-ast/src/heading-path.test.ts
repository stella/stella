import { expect, test } from "bun:test";

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

test("heading paths preserve statute division titles and discard completed siblings", () => {
  const paths = headingPathsByAnchor([
    paragraph("intro"),
    heading("part", 1, "ČÁST DRUHÁ\nPřímé platby"),
    heading("chapter", 2, "HLAVA I"),
    heading("division", 3, "Díl 1"),
    heading("section", 4, "§ 5\nŽádost o poskytnutí přímé platby"),
    paragraph("wording"),
    heading("next", 2, "Hlava II"),
    paragraph("next-wording"),
  ]);
  expect(paths.get("intro")).toEqual([]);
  expect(paths.get("wording")).toEqual([
    "ČÁST DRUHÁ\nPřímé platby",
    "HLAVA I",
    "Díl 1",
    "§ 5\nŽádost o poskytnutí přímé platby",
  ]);
  expect(paths.get("section")).toEqual(paths.get("wording"));
  expect(paths.get("next-wording")).toEqual([
    "ČÁST DRUHÁ\nPřímé platby",
    "Hlava II",
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
  expect(paths.get("facts-wording")).toEqual(["Odůvodnění", "Skutkový stav"]);
  expect(paths.get("law-wording")).toEqual(["Odůvodnění", "Právní posouzení"]);
  expect(paths.get("dissent-wording")).toEqual(["Odlišné stanovisko"]);
  expect(paths.get("reasoning")).toEqual(["Odůvodnění"]);
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
  for (const { anchorId } of blocks) {
    expect(paths.get(anchorId)).toEqual([title]);
  }
});
