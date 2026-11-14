import { expect, test } from "bun:test";

test("the popup renders a bundled stella symbol instead of a letter", async () => {
  const popup = await Bun.file(
    new URL("../src/entrypoints/popup/index.html", import.meta.url),
  ).text();
  const mark = /<div class="mark"[^>]*>([\s\S]*?)<\/div>/u.exec(popup)?.at(1);
  expect(mark).toBeDefined();
  expect(mark).toMatch(/<img\b[^>]*\bsrc="\/brand\/stella-symbol\.svg"/u);
  expect(mark?.trim()).not.toMatch(/^[Ss§]$/u);
});
