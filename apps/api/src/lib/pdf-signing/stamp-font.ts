/**
 * The font visible stamps are drawn in: DejaVu Sans (licence beside it in
 * `fonts/`), chosen for its coverage of Latin, Greek and Cyrillic scripts.
 *
 * Imported as a file asset rather than read from a path next to this module:
 * `bun build --compile` embeds an imported asset in the binary, while a path
 * built from `import.meta.dir` points into a source tree the compiled image
 * does not have. Loaded on first use, so importing this module can never fail
 * the API's startup.
 */

import stampFontLicensePath from "./fonts/DejaVuSans-LICENSE.txt" with { type: "file" };
import stampFontPath from "./fonts/DejaVuSans.ttf" with { type: "file" };

let loading: Promise<Uint8Array> | undefined;

export const loadStampFont = async (): Promise<Uint8Array> => {
  loading ??= Bun.file(stampFontPath)
    .bytes()
    .then((bytes) => new Uint8Array(bytes));
  try {
    return await loading;
  } catch (error) {
    // A failed read is retried on the next use rather than cached.
    loading = undefined;
    throw error;
  }
};

/** The font's licence, shipped with it wherever the font is embedded. */
export const loadStampFontLicense = async (): Promise<string> =>
  await Bun.file(stampFontLicensePath).text();
