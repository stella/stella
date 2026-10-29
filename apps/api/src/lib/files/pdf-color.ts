// The one module that turns colour into PDF content: content-stream operators
// (`r g b rg`, `r g b RG`) and @libpdf/core colour values. Colours come from
// @stll/brand or the named neutrals below; `no-raw-pdf-color-operators`
// rejects an operator or a library colour written with literal channels
// anywhere else.

import { rgb } from "@libpdf/core";
import type { Color } from "@libpdf/core";

import { NEUTRAL_SRGB } from "@stll/brand";
import type { SrgbColor } from "@stll/brand";

/** A grey with every channel at `level` (0 black, 1 white). */
const grey = (level: number): SrgbColor => [level, level, level];

/** The neutrals PDF output draws with, by role. */
export const PDF_NEUTRALS = {
  black: NEUTRAL_SRGB.black,
  white: NEUTRAL_SRGB.white,
  /** The signature stamp's signer name. */
  stampName: grey(0.1),
  /** The signature stamp's signing details. */
  stampDetail: [0.357, 0.373, 0.4],
} as const satisfies Record<string, SrgbColor>;

// A channel as a content-stream number: rounded to three decimals and printed
// in its shortest form, so `0.35` stays `0.35`, `0.34902` is `0.349` and the
// ends are `0` and `1`.
const pdfChannel = (value: number): string =>
  String(Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);

const channels = ([red, green, blue]: SrgbColor): string =>
  `${pdfChannel(red)} ${pdfChannel(green)} ${pdfChannel(blue)}`;

/** The `rg` operator that sets the non-stroking (fill and text) colour. */
export const pdfFillColor = (color: SrgbColor): string =>
  `${channels(color)} rg`;

/** The `RG` operator that sets the stroking colour. */
export const pdfStrokeColor = (color: SrgbColor): string =>
  `${channels(color)} RG`;

/** The colour as an @libpdf/core value, for its drawing calls. */
export const libpdfColor = ([red, green, blue]: SrgbColor): Color =>
  rgb(red, green, blue);
