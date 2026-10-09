import { expect, test } from "bun:test";
import path from "node:path";

import { VISUAL_PRESENTATION_CSS } from "../src/handlers/visual-sandbox/browser/presentation-css";
import { buildVisualFontFaces } from "./visual-sandbox-fonts";

test("visual font faces embed the app's exact font bytes and preserve typography metadata", async () => {
  const source = await Bun.file(
    new URL("../../web/src/fonts.css", import.meta.url),
  ).text();
  const embedded = await buildVisualFontFaces(VISUAL_PRESENTATION_CSS);
  expect(embedded.match(/url\(/gu)?.length).toBe(
    embedded.match(/url\("data:font\/woff2;base64,/gu)?.length,
  );
  const faces = [
    ...embedded.matchAll(/url\("data:font\/woff2;base64,([^"]+)"\)/gu),
  ];
  const selectedFaces = [
    ...source.matchAll(/@font-face\s*\{[^}]+\}/giu),
  ].filter((face) => {
    const family = /font-family:\s*"([^"]+)"/u.exec(face[0])?.at(1);
    return (
      family !== undefined && VISUAL_PRESENTATION_CSS.includes(`"${family}"`)
    );
  });
  expect(faces.length).toBe(selectedFaces.length);
  // Every selected face keeps its typography metadata (style, weight,
  // unicode range); only its URL becomes inline bytes.
  const withoutUrls = (css: string) =>
    css.replace(/url\([^)]*\)/gu, "url(FONT)");
  expect(withoutUrls(embedded)).toBe(
    withoutUrls(selectedFaces.map((face) => face[0]).join("\n")),
  );

  const selectedNames = new Set(
    selectedFaces.map(
      (face) => /url\("\/fonts\/([^"]+)"\)/u.exec(face[0])?.at(1) ?? "",
    ),
  );
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  let embeddedFonts = 0;
  for await (const fontPath of new Bun.Glob(
    "apps/web/public/fonts/*.woff2",
  ).scan({ cwd: repoRoot, absolute: true })) {
    if (!selectedNames.has(path.basename(fontPath))) {
      continue;
    }
    const bytes = Buffer.from(await Bun.file(fontPath).arrayBuffer());
    expect(embedded).toContain(bytes.toString("base64"));
    embeddedFonts += 1;
  }
  expect(embeddedFonts).toBe(selectedNames.size);
});
