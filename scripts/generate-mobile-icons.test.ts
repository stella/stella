import { expect, test } from "bun:test";

import {
  BAR_GLYPH_SIZES,
  barGlyphAssets,
  glyphOutline,
  glyphSvg,
} from "./generate-mobile-icons";

const OUTLINE = "M5 11 C 4 11,4 13,5 13 L 19 13 C 20 13,20 11,19 11 L 5 11";

const sprite = (glyph: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><symbol viewBox="0 0 24 24" id="icon-${glyph}">${body}</symbol></svg>`;

const filledPath = (d: string) =>
  `<path d="${d} " stroke="none" fill-rule="evenodd" fill="black"></path>`;

test("reads a glyph's filled outline from lucide's sprite", () => {
  expect(glyphOutline(sprite("minus", filledPath(OUTLINE)), "minus")).toEqual([
    OUTLINE,
  ]);
});

test("refuses a glyph the sprite does not have", () => {
  expect(() =>
    glyphOutline(sprite("minus", filledPath(OUTLINE)), "plus"),
  ).toThrow("plus");
});

test("refuses a glyph drawn with anything but filled paths", () => {
  expect(() =>
    glyphOutline(
      sprite("minus", `${filledPath(OUTLINE)}<circle cx="12" cy="12" r="2"/>`),
      "minus",
    ),
  ).toThrow("more than filled paths");
});

test("refuses a name that is not a lucide glyph's", () => {
  expect(() => glyphOutline("", "../x")).toThrow("not a lucide glyph name");
});

test("draws the outline on lucide's grid at the bar's size", () => {
  const svg = glyphSvg([OUTLINE], 22, "1.0.0");
  expect(svg).toContain('width="22" height="22" viewBox="0 0 24 24"');
  expect(svg).toContain(`<path fill-rule="evenodd" d="${OUTLINE}"/>`);
  expect(svg).toContain("lucide-static v1.0.0 (ISC)");
});

test("every bar glyph becomes a template image the app names", () => {
  const all = Object.keys(BAR_GLYPH_SIZES)
    .map((glyph) => sprite(glyph, filledPath(OUTLINE)))
    .join("");
  const artifacts = barGlyphAssets(all, "1.0.0");
  const names = artifacts.find(({ path }) =>
    path.endsWith("bar-glyphs.gen.ts"),
  );
  for (const glyph of Object.keys(BAR_GLYPH_SIZES)) {
    const contents = artifacts.find(({ path }) =>
      path.endsWith(`lucide-${glyph}.imageset/Contents.json`),
    )?.contents;
    expect(JSON.parse(contents ?? "{}")).toMatchObject({
      images: [{ filename: `lucide-${glyph}.svg` }],
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    });
    expect(names?.contents).toContain(`"lucide-${glyph}"`);
  }
});
