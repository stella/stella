import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  loadStampFontLicenses,
  loadStampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import { stampTextCheck } from "@/api/lib/files/pdf-signing/stamp-text";

describe("the stamp fonts", () => {
  test("travel inside a compiled build instead of being read from the source tree", async () => {
    // The API ships as `bun build --compile`; only imported assets make it
    // into that binary, so the bundle must carry every face, its licence,
    // and the shaper's WebAssembly.
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "stamp-font.ts")],
      target: "bun",
    });
    expect(built.success).toBe(true);
    const assets = built.outputs
      .filter((output) => output.kind === "asset")
      .map((output) => path.extname(output.path));
    expect(assets.toSorted()).toEqual([
      ".ttf",
      ".ttf",
      ".ttf",
      ".ttf",
      ".ttf",
      ".txt",
      ".txt",
      ".txt",
      ".txt",
      ".wasm",
    ]);
  });

  test("load on first use and cover the scripts the stamp promises", async () => {
    const check = stampTextCheck(await loadStampFonts());

    for (const sample of [
      "Jiří Čermák Łódź Ģirts Ελληνικά Привет",
      "محمد عبد الله",
      "דוד כהן",
      "王小明 山田太郎 やまだ カタカナ",
      "김민준",
      "राजेश कुमार",
      "สมชาย ใจดี",
    ]) {
      expect(check.canDraw(sample)).toBe(true);
    }
    // An ideographic variation sequence names a glyph the faces cannot select.
    expect(check.canDraw("\u845B\u{E0100}")).toBe(false);
    const licenses = await loadStampFontLicenses();
    expect(licenses.join("\n")).toContain("Bitstream Vera");
    expect(licenses.join("\n")).toContain("SIL Open Font License");
  });
});
