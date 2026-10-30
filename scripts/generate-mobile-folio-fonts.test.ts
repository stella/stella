import { expect, test } from "bun:test";

import { appFacesOf, renderFolioFonts } from "./generate-mobile-folio-fonts";
import type { CatalogueFace } from "./generate-mobile-folio-fonts";

const tinos = (subset: string, unicodeRange: string): CatalogueFace => ({
  family: "Tinos",
  subset,
  style: "normal",
  weight: 400,
  unicodeRange,
  woff2: `fonts/tinos/files/tinos-${subset}-400-normal.woff2`,
});

const TINOS: CatalogueFace[] = [
  tinos("cyrillic", "U+0301,U+0400-045F"),
  tinos("latin-ext", "U+0100-02BA,U+02BD-02C5"),
  tinos("latin", "U+0000-00FF,U+0131"),
];

test("keeps the Latin faces and leaves the other scripts to the system", () => {
  expect(appFacesOf(TINOS)).toEqual([
    {
      family: "Tinos",
      style: "normal",
      weight: 400,
      unicodeRange: "U+0100-02BA,U+02BD-02C5",
      file: "@stll/folio-fonts/fonts/tinos/files/tinos-latin-ext-400-normal.woff2",
    },
    {
      family: "Tinos",
      style: "normal",
      weight: 400,
      unicodeRange: "U+0000-00FF,U+0131",
      file: "@stll/folio-fonts/fonts/tinos/files/tinos-latin-400-normal.woff2",
    },
  ]);
});

test("keeps the Arabic face of a family that has one", () => {
  expect(
    appFacesOf([
      {
        family: "Noto Sans Arabic",
        subset: "arabic",
        style: "normal",
        weight: 700,
        unicodeRange: "U+0600-06FF",
        woff2:
          "fonts/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2",
      },
    ]),
  ).toEqual([
    {
      family: "Noto Sans Arabic",
      style: "normal",
      weight: 700,
      unicodeRange: "U+0600-06FF",
      file: "@stll/folio-fonts/fonts/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2",
    },
  ]);
});

test("imports each font file once and names the face it declares", () => {
  const source = renderFolioFonts(appFacesOf(TINOS));
  expect(source).toContain(
    'import tinosLatin400Normal from "@stll/folio-fonts/fonts/tinos/files/tinos-latin-400-normal.woff2";',
  );
  expect(source).toContain("source: tinosLatin400Normal,");
  expect(source).not.toContain("cyrillic");
});
