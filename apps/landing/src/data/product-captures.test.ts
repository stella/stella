import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import { localeCodes } from "../i18n/config";
import { productCaptures } from "./product-captures";

const publicRoot = new URL("../../public/", import.meta.url);
const productRoot = new URL("media/products/", publicRoot);

const capturePaths = Object.values(productCaptures).flatMap((capture) =>
  Object.values(capture).flatMap((sources) => Object.values(sources)),
);

test("every shipped product PNG has a declared capture and every capture exists", () => {
  const pngPaths = readdirSync(productRoot)
    .filter((name) => name.endsWith(".png"))
    .map((name) => `/media/products/${name}`);

  expect(new Set(pngPaths)).toEqual(new Set(capturePaths));
  for (const publicPath of capturePaths) {
    expect(
      existsSync(new URL(publicPath.slice(1), publicRoot)),
      publicPath,
    ).toBe(true);
  }
});

test("each locale selects its available capture or the existing default", () => {
  for (const [shot, capture] of Object.entries(productCaptures)) {
    expect(Object.keys(capture.src).toSorted()).toEqual(
      [...localeCodes].toSorted(),
    );
    for (const locale of localeCodes) {
      const localizedPath = `/media/products/${shot}-${locale}.png`;
      const hasLocalizedCapture =
        (locale === "cs" || locale === "sk") &&
        existsSync(new URL(localizedPath.slice(1), publicRoot));
      const expectedSrc = hasLocalizedCapture
        ? localizedPath
        : `/media/products/${shot}.png`;
      expect(expectedSrc).toBe(capture.src[locale]);
      expect(expectedSrc.replace(/\.png$/u, "-dark.png")).toBe(
        capture.darkSrc[locale],
      );
    }
  }
});
