import { expect, test } from "bun:test";

import {
  fontFacesOf,
  fontsourceImportsOf,
  renderFolioFonts,
} from "./generate-mobile-folio-fonts";

const TINOS = `/* tinos-cyrillic-400-normal */
@font-face {
  font-family: 'Tinos';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/tinos-cyrillic-400-normal.woff2) format('woff2'), url(./files/tinos-cyrillic-400-normal.woff) format('woff');
  unicode-range: U+0301,U+0400-045F;
}

/* tinos-latin-ext-400-normal */
@font-face {
  font-family: 'Tinos';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/tinos-latin-ext-400-normal.woff2) format('woff2'), url(./files/tinos-latin-ext-400-normal.woff) format('woff');
  unicode-range: U+0100-02BA,U+02BD-02C5;
}

/* tinos-latin-400-normal */
@font-face {
  font-family: 'Tinos';
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url(./files/tinos-latin-400-normal.woff2) format('woff2'), url(./files/tinos-latin-400-normal.woff) format('woff');
  unicode-range: U+0000-00FF,U+0131;
}
`;

test("reads the fontsource stylesheets editor.css imports, in order", () => {
  expect(
    fontsourceImportsOf(
      '@import "@fontsource/carlito/400.css";@import "@fontsource/tinos/700-italic.css";.folio{color:red}',
    ),
  ).toEqual([
    "@fontsource/carlito/400.css",
    "@fontsource/tinos/700-italic.css",
  ]);
});

test("keeps the Latin faces and leaves the other scripts to the system", () => {
  expect(fontFacesOf(TINOS, "tinos")).toEqual([
    {
      family: "Tinos",
      style: "normal",
      weight: 400,
      unicodeRange: "U+0100-02BA,U+02BD-02C5",
      file: "@fontsource/tinos/files/tinos-latin-ext-400-normal.woff2",
    },
    {
      family: "Tinos",
      style: "normal",
      weight: 400,
      unicodeRange: "U+0000-00FF,U+0131",
      file: "@fontsource/tinos/files/tinos-latin-400-normal.woff2",
    },
  ]);
});

test("keeps the Arabic face of a family that has one", () => {
  const css = `@font-face {
  font-family: 'Noto Sans Arabic';
  font-style: normal;
  font-weight: 700;
  src: url(./files/noto-sans-arabic-arabic-700-normal.woff2) format('woff2');
  unicode-range: U+0600-06FF;
}`;
  expect(fontFacesOf(css, "noto-sans-arabic")).toEqual([
    {
      family: "Noto Sans Arabic",
      style: "normal",
      weight: 700,
      unicodeRange: "U+0600-06FF",
      file: "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2",
    },
  ]);
});

test("imports each font file once and names the face it declares", () => {
  const source = renderFolioFonts(fontFacesOf(TINOS, "tinos"));
  expect(source).toContain(
    'import tinosLatin400Normal from "@fontsource/tinos/files/tinos-latin-400-normal.woff2";',
  );
  expect(source).toContain("source: tinosLatin400Normal,");
  expect(source).not.toContain("cyrillic");
});
