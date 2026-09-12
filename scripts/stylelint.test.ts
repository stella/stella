import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";

const configFile = fileURLToPath(
  new URL("../.stylelintrc.json", import.meta.url),
);

const lintCss = async (code: string) =>
  await stylelint.lint({ code, codeFilename: "guard.css", configFile });

describe("CSS correctness guard", () => {
  test.each([
    ["color-no-invalid-hex", ".sample { color: #12; }"],
    [
      "declaration-block-no-duplicate-properties",
      ".sample { display: block; display: block; }",
    ],
    ["declaration-property-value-no-unknown", ".sample { display: blcok; }"],
    ["property-no-unknown", ".sample { colro: red; }"],
    ["selector-no-unmatchable", "label:checked { color: red; }"],
  ])("rejects %s through the production config", async (rule, code) => {
    const result = await lintCss(code);
    expect(result.errored).toBe(true);
    expect(result.results.flatMap((file) => file.warnings)).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule })]),
    );
  });

  test("accepts Tailwind v4 directives, modern CSS, and deliberate fallbacks", async () => {
    const result = await lintCss(`
      @import "tailwindcss";
      @theme { --color-brand: oklch(0.7 0.1 250); }
      @custom-variant dark (&:where(.dark, .dark *));
      @utility content-auto { content-visibility: auto; }
      .sample {
        @apply flex;
        color: red;
        color: color-mix(in oklch, var(--color-brand), transparent 20%);
        padding-inline: 1rem;
        &:focus-visible { outline: 2px solid currentColor; }
      }
    `);
    expect(result.errored).toBe(false);
    expect(result.results.flatMap((file) => file.warnings)).toEqual([]);
  });

  test("does not silently retain stale suppressions", async () => {
    const result = await lintCss(`
      /* stylelint-disable-next-line color-no-invalid-hex -- deliberate fixture */
      .sample { color: #fff; }
    `);
    expect(result.errored).toBe(true);
  });

  test("requires CSS suppressions to name the rule", async () => {
    const result = await lintCss(`
      /* stylelint-disable -- deliberate fixture */
      .sample { color: #12; }
    `);
    expect(result.errored).toBe(true);
  });
});
