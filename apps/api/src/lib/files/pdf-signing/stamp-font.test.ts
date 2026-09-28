import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  loadStampFont,
  loadStampFontLicense,
} from "@/api/lib/files/pdf-signing/stamp-font";

describe("the stamp font", () => {
  test("travels inside a compiled build instead of being read from the source tree", async () => {
    // The API ships as `bun build --compile`; only imported assets make it
    // into that binary, so the bundle must carry the font and its licence.
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "stamp-font.ts")],
      target: "bun",
    });
    expect(built.success).toBe(true);
    const assets = built.outputs
      .filter((output) => output.kind === "asset")
      .map((output) => path.extname(output.path));
    expect(assets.toSorted()).toEqual([".ttf", ".txt"]);
  });

  test("loads on first use and covers the scripts the stamp promises", async () => {
    const font = PDF.create().embedFont(await loadStampFont());

    expect(font.canEncode("Jiří Čermák Łódź Ģirts Ελληνικά Привет")).toBe(true);
    expect(await loadStampFontLicense()).toContain("Bitstream Vera");
  });
});
