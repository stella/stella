/**
 * The fonts visible stamps are drawn in, and the shaper that sets text in
 * them.
 *
 * A fallback chain: DejaVu Sans for Latin, Greek, Cyrillic, Arabic and
 * Hebrew, then Noto subsets for Devanagari, Thai, CJK and Hangul (built by
 * `src/scripts/subset-stamp-fonts.ts`; licences beside them in `fonts/`).
 * Each character takes the first face that owns its script, and a character
 * of no particular script (digits, punctuation, spaces) stays in the face
 * of the text around it.
 *
 * Imported as file assets rather than read from a path next to this module:
 * `bun build --compile` embeds an imported asset in the binary, while a path
 * built from `import.meta.dir` points into a source tree the compiled image
 * does not have. The shaper's WebAssembly is embedded the same way and
 * handed to it as bytes. Loaded on first use, so importing this module can
 * never fail the API's startup.
 */

import { panic } from "better-result";

import {
  getShaper,
  parseSfnt,
  type SfntFont,
  type Shaper,
} from "@stll/folio-core/text-shaping";

import dejaVuLicensePath from "./fonts/DejaVuSans-LICENSE.txt" with { type: "file" };
import dejaVuPath from "./fonts/DejaVuSans.ttf" with { type: "file" };
import cjkLicensePath from "./fonts/NotoSansCJK-LICENSE.txt" with { type: "file" };
import devanagariLicensePath from "./fonts/NotoSansDevanagari-LICENSE.txt" with { type: "file" };
import devanagariPath from "./fonts/NotoSansDevanagari-Subset.ttf" with { type: "file" };
import hangulPath from "./fonts/NotoSansKR-Subset.ttf" with { type: "file" };
import hanPath from "./fonts/NotoSansSC-Subset.ttf" with { type: "file" };
import thaiLicensePath from "./fonts/NotoSansThai-LICENSE.txt" with { type: "file" };
import thaiPath from "./fonts/NotoSansThai-Subset.ttf" with { type: "file" };

import textShaperPath from "#text-shaper.wasm" with { type: "file" };

/** One face of the stamp's fallback chain. */
export type StampFace = {
  /**
   * Names the face in the PDF resources and seeds its subset tag, so it
   * must stay the same between the two signing phases.
   */
  key: string;
  font: SfntFont;
  /** Characters this face is the first choice for. */
  owns: RegExp;
};

export type StampFonts = {
  /** In fallback order. */
  faces: readonly StampFace[];
  shaper: Shaper;
};

const FACE_SOURCES = [
  {
    key: "DejaVuSans",
    path: dejaVuPath,
    owns: /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}]/u,
  },
  {
    key: "NotoSansDevanagari",
    path: devanagariPath,
    owns: /\p{Script=Devanagari}/u,
  },
  { key: "NotoSansThai", path: thaiPath, owns: /\p{Script=Thai}/u },
  {
    key: "NotoSansSC",
    path: hanPath,
    // Ideographs, kana, and the CJK punctuation and fullwidth forms that
    // belong with them.
    owns: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]/u,
  },
  { key: "NotoSansKR", path: hangulPath, owns: /\p{Script=Hangul}/u },
] as const;

const LICENSE_PATHS = [
  dejaVuLicensePath,
  cjkLicensePath,
  devanagariLicensePath,
  thaiLicensePath,
] as const;

const readFace = async ({
  key,
  owns,
  path,
}: (typeof FACE_SOURCES)[number]): Promise<StampFace> => {
  const parsed = parseSfnt(new Uint8Array(await Bun.file(path).bytes()));
  if (parsed.isErr()) {
    // The faces are built and committed with the code; one that does not
    // parse is a broken build, not a runtime condition.
    return panic(`The stamp font ${key} does not parse`, parsed.error);
  }
  return { font: parsed.value, key, owns };
};

const readFonts = async (): Promise<StampFonts> => {
  const [faces, shaper] = await Promise.all([
    Promise.all(FACE_SOURCES.map(readFace)),
    Bun.file(textShaperPath)
      .bytes()
      .then(async (wasm) => await getShaper({ wasm })),
  ]);
  return { faces, shaper };
};

let loaded: StampFonts | undefined;

/** Only a successful read is kept, so a failed one is retried next use. */
export const loadStampFonts = async (): Promise<StampFonts> => {
  loaded ??= await readFonts();
  return loaded;
};

/** The fonts' licences, shipped with them wherever they are embedded. */
export const loadStampFontLicenses = async (): Promise<string[]> =>
  await Promise.all(
    LICENSE_PATHS.map(async (path) => await Bun.file(path).text()),
  );
