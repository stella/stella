import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { buildRunMap } from "./run-map";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const parseParagraph = (inner: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(`<w:p xmlns:w="${W_NS}">${inner}</w:p>`);
  const p = doc.documentElement;
  if (!p) {
    throw new Error("no paragraph element");
  }
  return p;
};

const offsets = (p: slimdom.Element) =>
  buildRunMap(p).map((s) => [s.start, s.length] as const);

describe("buildRunMap offset alignment with collectText", () => {
  test("a leading tab occupies one offset so following text is not skewed", () => {
    // collectText renders this as "\tHeading"; "Heading" must start at 1.
    const p = parseParagraph("<w:r><w:tab/><w:t>Heading</w:t></w:r>");
    expect(offsets(p)).toEqual([[1, 7]]);
  });

  test("a line break between runs occupies one offset", () => {
    // collectText renders this as "A\nB"; "B" must start at 2.
    const p = parseParagraph("<w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r>");
    expect(offsets(p)).toEqual([
      [0, 1],
      [2, 1],
    ]);
  });

  test("plain text without tabs or breaks stays contiguous from 0", () => {
    const p = parseParagraph(
      "<w:r><w:t>ab</w:t></w:r><w:r><w:t>cd</w:t></w:r>",
    );
    expect(offsets(p)).toEqual([
      [0, 2],
      [2, 2],
    ]);
  });

  test("tabs and breaks accumulate across multiple runs", () => {
    // collectText: "\t1.1\tHeading" -> indices: tab(0) "1.1"(1-3) tab(4) "Heading"(5-11)
    const p = parseParagraph(
      "<w:r><w:tab/><w:t>1.1</w:t><w:tab/><w:t>Heading</w:t></w:r>",
    );
    expect(offsets(p)).toEqual([
      [1, 3],
      [5, 7],
    ]);
  });

  test("deleted content is skipped and does not consume offsets", () => {
    const p = parseParagraph(
      "<w:del><w:r><w:delText>X</w:delText></w:r></w:del>" +
        "<w:r><w:t>Y</w:t></w:r>",
    );
    expect(offsets(p)).toEqual([[0, 1]]);
  });
});
