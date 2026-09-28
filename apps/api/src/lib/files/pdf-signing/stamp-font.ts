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

let loaded: Uint8Array | undefined;

/** Only a successful read is kept, so a failed one is retried next use. */
export const loadStampFont = async (): Promise<Uint8Array> => {
  loaded ??= new Uint8Array(await Bun.file(stampFontPath).bytes());
  return loaded;
};

/** The font's licence, shipped with it wherever the font is embedded. */
export const loadStampFontLicense = async (): Promise<string> =>
  await Bun.file(stampFontLicensePath).text();
