import { expect, test } from "bun:test";

const popupFile = async (name: string) =>
  await Bun.file(
    new URL(`../src/entrypoints/popup/${name}`, import.meta.url),
  ).text();

test("the popup draws the bundled stella symbol instead of a letter", async () => {
  const [popup, style] = await Promise.all([
    popupFile("index.html"),
    popupFile("style.css"),
  ]);
  const mark = /<div class="mark"[^>]*>([\s\S]*?)<\/div>/u.exec(popup)?.at(1);
  expect(mark).toBeDefined();
  expect(mark?.trim()).toBe('<span class="mark-symbol"></span>');
  // The symbol is the mask the tile's colour fills, so it follows the theme.
  const symbolRule = /\.mark-symbol \{([^}]*)\}/u.exec(style)?.at(1);
  expect(symbolRule).toMatch(/mask: url\("\/brand\/stella-symbol\.svg"\)/u);
  expect(symbolRule).toMatch(/background: currentcolor;/u);
});
