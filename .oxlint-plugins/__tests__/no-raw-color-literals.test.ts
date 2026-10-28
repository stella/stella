import { describe, expect, test } from "bun:test";

import {
  findPdfColorOperator,
  findRawColor,
} from "../no-raw-color-literals.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

describe("findRawColor", () => {
  test.each([
    ["#59a1d4", "#59a1d4"],
    ["#FFF", "#FFF"],
    ["#0000001a", "#0000001a"],
    ["#000", "#000"],
    ["border: 1px solid #d4d4d8; margin: 0", "#d4d4d8"],
    ["border-top: 1px solid #333", "#333"],
    ["color:#000;", "#000"],
    ['<rect fill="#000"/>', "#000"],
    ["linear-gradient(to top, #000, transparent)", "#000"],
    ["var(--ink, #111)", "#111"],
    ["bg-[#fafafa] text-sm", "#fafafa"],
    ["0 1px 2px rgb(0 0 0 / 0.2)", "rgb(0 0 0 / 0.2)"],
    ["rgba(255, 255, 255, 0.5)", "rgba(255, 255, 255, 0.5)"],
    ["hsl(210 50% 40%)", "hsl(210 50% 40%)"],
    ["oklch(0.7 0.1 240)", "oklch(0.7 0.1 240)"],
    ["bg-[oklch(0.94_0.045_var(--hue))]", "oklch(0.94_0.045_var"],
    ["color(display-p3 1 0 0)", "color(display-p3 1 0 0)"],
  ])("reports %j", (value, match) => {
    expect(findRawColor(value)).toBe(match);
  });

  test.each([
    "var(--primary)",
    "rgb(from var(--color-info) r g b / 0.12)",
    "color-mix(in oklch, var(--a) 40%, transparent)",
    "issue #1139",
    "Fixed in #4072.",
    "(#4072)",
    "quarantine: #1234",
    "23.10.2026 #205",
    "#303 Change 303",
    "Refs #12, #13",
    "&#124;",
    "#main",
    "/path#section",
    "Select a color(s)",
    "rgb(",
    "transparent",
  ])("accepts %j", (value) => {
    expect(findRawColor(value)).toBeNull();
  });
});

describe("findPdfColorOperator", () => {
  test.each([
    ["0.35 0.35 0.35 RG", "0.35 0.35 0.35 RG"],
    ["q\n0.1 0.1 0.1 rg\nBT", "0.1 0.1 0.1 rg"],
    ["0 0 0 1 k", "0 0 0 1 k"],
    ["q\n0 g\nQ", "0 g"],
    [".5 G", ".5 G"],
  ])("reports %j", (value, match) => {
    expect(findPdfColorOperator(value)).toBe(match);
  });

  test.each([
    "Add 5 g of salt",
    "0.300 0.300 10 20 re",
    "0.6 w",
    "1 0 0 1 10 20 Tm",
    "rgb",
  ])("accepts %j", (value) => {
    expect(findPdfColorOperator(value)).toBeNull();
  });
});

describe("no-raw-color-literals", () => {
  test("reports raw colours in strings and templates, not tokens", async () => {
    expect(
      await lintSingleRule(
        "no-raw-color-literals",
        [
          'const accent = "#59a1d4";',
          "const shadow = `0 1px 2px rgb(0 0 0 / 0.2)`;",
          'const token = "var(--primary)";',
          'const ticket = "issue #1139";',
          "declare const r: number;",
          `const computed = \`rgb(\${r} 0 0)\`;`,
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("accepts tokens, issue references and computed colour", async () => {
    expect(
      await lintSingleRule(
        "no-raw-color-literals",
        [
          'const token = "var(--primary)";',
          'const relative = "rgb(from var(--color-info) r g b / 0.12)";',
          'const ticket = "Fixed in #1139 (see #4072)";',
          "declare const r: number;",
          `const computed = \`rgb(\${r} \${r} \${r})\`;`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("no-raw-pdf-color-operators", () => {
  test("reports inline operators and literal library colours", async () => {
    expect(
      await lintSingleRule(
        "no-raw-pdf-color-operators",
        [
          'import { rgb, white } from "@libpdf/core";',
          'const stroke = "0.35 0.35 0.35 RG";',
          "declare const r: number;",
          `const fill = \`\${r} \${r} \${r} rg\`;`,
          "const literal = rgb(0, 0, 0);",
          "const computed = rgb(r, r, r);",
          'const prose = "5 g of salt";',
          "export { computed, fill, literal, prose, stroke, white };",
        ].join("\n"),
        { plugin: "no-raw-color-literals" },
      ),
    ).toEqual([1, 2, 4, 5]);
  });

  test("accepts helper-built operators, computed colours and prose", async () => {
    expect(
      await lintSingleRule(
        "no-raw-pdf-color-operators",
        [
          'import { rgb } from "@libpdf/core";',
          "declare const channels: string;",
          "declare const r: number;",
          `const fill = \`\${channels} rg\`;`,
          "const computed = rgb(r, r, r);",
          'const prose = "Add 5 g of salt";',
          'const geometry = "0.300 0.300 10 20 re";',
          "export { computed, fill, geometry, prose };",
        ].join("\n"),
        { plugin: "no-raw-color-literals" },
      ),
    ).toEqual([]);
  });
});
