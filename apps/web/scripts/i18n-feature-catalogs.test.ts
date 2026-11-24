import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  featureCatalogRoots,
  featureDirectoryOf,
} from "./i18n-feature-catalogs";

const webRoot = mkdtempSync(path.join(tmpdir(), "feature-catalogs-"));
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

const catalogAt = (directory: string) => {
  mkdirSync(path.join(webRoot, directory), { recursive: true });
  writeFileSync(path.join(webRoot, directory, "en.json"), "{}");
};

test("finds every feature catalog but the app's own and the fixtures", () => {
  catalogAt("src/i18n/langs");
  catalogAt("src/components/docx/example/i18n/langs");
  catalogAt("src/features/other/i18n/langs");
  catalogAt("src/i18n/__fixtures__/sample/i18n/langs");
  expect(featureCatalogRoots(webRoot)).toEqual([
    "src/components/docx/example/i18n/langs",
    "src/features/other/i18n/langs",
  ]);
});

test("a catalog's unused-key scan covers the feature that owns it", () => {
  expect(featureDirectoryOf("src/components/docx/example/i18n/langs")).toBe(
    "src/components/docx/example",
  );
});
