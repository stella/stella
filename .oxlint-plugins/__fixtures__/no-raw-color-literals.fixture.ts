// Passive regression fixture for `no-raw-color-literals/no-raw-color-literals`
// and `no-raw-color-literals/no-raw-pdf-color-operators`.
//
// `oxlint-disable-next-line` directives suppress cases the rules MUST flag;
// a regression makes them unused and CI fails. Lines marked `expect-clean`
// cover the accepted forms and must keep passing.

import { rgb } from "@libpdf/core";

declare const red: number;
declare const green: number;
declare const blue: number;
declare const issue: number;

// --- Flagged: a raw colour in a string ---

// oxlint-disable-next-line no-raw-color-literals/no-raw-color-literals -- fixture: a hex colour
export const hex = "#59a1d4";
// oxlint-disable-next-line no-raw-color-literals/no-raw-color-literals -- fixture: a digits-only hex in a CSS value
export const border = "border: 1px solid #000";
// oxlint-disable-next-line no-raw-color-literals/no-raw-color-literals -- fixture: a colour function with literal channels
export const shadow = "0 1px 2px rgb(0 0 0 / 0.2)";
// oxlint-disable-next-line no-raw-color-literals/no-raw-color-literals -- fixture: an arbitrary Tailwind colour
export const arbitrary = "bg-[oklch(0.94_0.045_240)]";
// oxlint-disable-next-line no-raw-color-literals/no-raw-color-literals -- fixture: a static template
export const template = `fill: #fafafa;`;

// --- Accepted: tokens, references and computed colour ---

// expect-clean: no-raw-color-literals/no-raw-color-literals
export const token = "var(--primary)";
// expect-clean: no-raw-color-literals/no-raw-color-literals
export const relative = "rgb(from var(--color-info) r g b / 0.12)";
// expect-clean: no-raw-color-literals/no-raw-color-literals
export const reference = `Fixed in #1139 (see #4072), entity &#124;`;
// expect-clean: no-raw-color-literals/no-raw-color-literals
export const computed = `rgb(${red} ${green} ${blue})`;
// expect-clean: no-raw-color-literals/no-raw-color-literals
export const anchor = `#main #${issue}`;

// --- Flagged: a PDF colour named inline ---

// oxlint-disable-next-line no-raw-color-literals/no-raw-pdf-color-operators -- fixture: a stroke operator
export const stroke = "0.35 0.35 0.35 RG";
// oxlint-disable-next-line no-raw-color-literals/no-raw-pdf-color-operators -- fixture: a grey fill line in a content stream
export const grayFill = "q\n0 g\nQ";
// oxlint-disable-next-line no-raw-color-literals/no-raw-pdf-color-operators -- fixture: interpolated operands
export const fill = `${red} ${green} ${blue} rg`;
// oxlint-disable-next-line no-raw-color-literals/no-raw-pdf-color-operators -- fixture: a library colour with literal channels
export const libraryColor = rgb(0, 0, 0);

// --- Accepted: prose and computed library colours ---

// expect-clean: no-raw-color-literals/no-raw-pdf-color-operators
export const prose = "Add 5 g of salt";
// expect-clean: no-raw-color-literals/no-raw-pdf-color-operators
export const computedLibraryColor = rgb(red, green, blue);
