import { expect, test } from "bun:test";
import path from "node:path";

import { buildVisualFontFaces } from "./visual-sandbox-fonts";

test("visual font faces embed the app's exact font bytes and preserve typography metadata", async () => {
  const source = await Bun.file(
    new URL("../../web/src/fonts.css", import.meta.url),
  ).text();
  const embedded = await buildVisualFontFaces();
  expect(embedded.match(/url\(/gu)?.length).toBe(
    embedded.match(/url\("data:font\/woff2;base64,/gu)?.length,
  );
  expect(embedded.replace(/url\([^)]*\)/gu, "url(FONT)")).toBe(
    source.replace(/url\([^)]*\)/gu, "url(FONT)"),
  );
  const sources = [...source.matchAll(/url\([^)]*\)/gu)];
  const faces = [
    ...embedded.matchAll(/url\("data:font\/woff2;base64,([^"]+)"\)/gu),
  ];
  expect(faces.length).toBe(sources.length);
  expect(faces.length).toBeGreaterThan(0);

  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  let fonts = 0;
  for await (const fontPath of new Bun.Glob(
    "apps/web/public/fonts/*.woff2",
  ).scan({ cwd: repoRoot, absolute: true })) {
    const bytes = Buffer.from(await Bun.file(fontPath).arrayBuffer());
    expect(embedded).toContain(bytes.toString("base64"));
    fonts += 1;
  }
  expect(fonts).toBe(faces.length);
});
