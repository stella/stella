import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

// Readers zoom through the floating bar only; the bare triad is the PDF
// controls' building block. A reader that imports the triad again could mount
// it in a header row, so the importers of the bare triad are pinned here.
const WEB_SOURCE = nodePath.join(import.meta.dirname, "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;
const BARE_TRIAD_IMPORT =
  /import\s*\{[^}]*\bZoomControls\b[^}]*\}\s*from\s*"@\/components\/inspector\/zoom-controls"/u;
const BARE_TRIAD_IMPORTERS = ["components/pdf/peek/peek-pdf-viewer.tsx"];

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(nodePath.extname(entry.name)) &&
      !TEST_FILE_PATTERN.test(entry.name)
      ? [path]
      : [];
  });

describe("zoom controls owner", () => {
  test("only the PDF controls import the bare zoom triad", () => {
    const importers = listSourceFiles(WEB_SOURCE)
      .filter((path) => BARE_TRIAD_IMPORT.test(readFileSync(path, "utf-8")))
      .map((path) => repoRelativePath(WEB_SOURCE, path))
      .toSorted();

    expect(importers).toEqual(BARE_TRIAD_IMPORTERS);
  });

  test("the pattern sees a bare triad import beside other names", () => {
    expect(
      BARE_TRIAD_IMPORT.test(
        'import { FloatingZoomControls, ZoomControls } from "@/components/inspector/zoom-controls";',
      ),
    ).toBe(true);
    expect(
      BARE_TRIAD_IMPORT.test(
        'import { FloatingZoomControls } from "@/components/inspector/zoom-controls";',
      ),
    ).toBe(false);
  });
});
