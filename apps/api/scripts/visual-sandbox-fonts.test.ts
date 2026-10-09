import { expect, test } from "bun:test";

import { VISUAL_PRESENTATION_CSS } from "../src/handlers/visual-sandbox/browser/presentation";
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

  for (const face of selectedFaces) {
    const url = /url\("([^"]+)"\)/u.exec(face[0])?.at(1);
    if (!url) {
      continue;
    }
    const bytes = Buffer.from(
      await Bun.file(
        new URL(`../../web/public${url}`, import.meta.url),
      ).arrayBuffer(),
    );
    expect(embedded).toContain(bytes.toString("base64"));
  }
});
