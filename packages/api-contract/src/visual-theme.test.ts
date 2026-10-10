import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { visualGuestMessageSchema } from "./visual-sandbox";
import {
  VISUAL_THEME_VARIABLES,
  visualThemeMessageSchema,
  visualThemeSchema,
} from "./visual-theme";

describe("visual theme boundary", () => {
  test("accepts every real theme token value", () => {
    const stylesheet = readFileSync(
      new URL("../../ui/src/styles/theme.css", import.meta.url),
      "utf-8",
    );
    const declaredTokens = new Set<string>(VISUAL_THEME_VARIABLES);
    const declarations = [
      ...stylesheet.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/giu),
    ].filter((match) => declaredTokens.has(match.at(1) ?? ""));

    expect(declarations.length).toBeGreaterThan(VISUAL_THEME_VARIABLES.length);
    for (const declaration of declarations) {
      const name = declaration.at(1);
      const value = declaration.at(2)?.trim();
      expect(name).toBeDefined();
      expect(value).toBeDefined();
      expect(
        v.safeParse(visualThemeSchema, {
          appearance: "dark",
          variables: { [name ?? ""]: value },
        }).success,
      ).toBe(true);
    }
  });

  test("refuses values outside each token kind", () => {
    const nonThemeValues = [
      ["--background", "1rem"],
      ["--foreground", '"Slate"'],
      ["--radius", "red"],
      ["--radius", "1rem solid"],
      ["--font-sans", "oklch(0.7 0.1 150)"],
      ["--font-mono", "12px"],
      ["--chart-1", "linear-gradient(red, blue)"],
      ["--primary", ""],
      ["--primary", "oklch(0.7 0.1 150); color: red"],
      ["--primary", "oklch(0.7 0.1 150 /* note */)"],
      ["--primary", "x".repeat(513)],
    ] as const;
    for (const [name, value] of nonThemeValues) {
      expect(
        v.safeParse(visualThemeSchema, {
          appearance: "light",
          variables: { [name]: value },
        }).success,
      ).toBe(false);
    }
  });
  test("refuses unknown names and keeps themes out of guest messages", () => {
    for (const name of [
      "--unknown",
      "color",
      "--chart-9",
      "--foreground;",
      "--Foreground",
    ]) {
      expect(
        v.safeParse(visualThemeSchema, {
          appearance: "light",
          variables: { [name]: "red" },
        }).success,
      ).toBe(false);
    }
    const prototypeKey = v.safeParse(visualThemeSchema, {
      appearance: "light",
      variables: { ["__proto__"]: "red" },
    });
    expect(
      prototypeKey.success && Object.keys(prototypeKey.output.variables),
    ).toEqual([]);
    const message = {
      kind: "theme",
      theme: { appearance: "dark", variables: { "--foreground": "white" } },
    };
    expect(v.safeParse(visualThemeMessageSchema, message).success).toBe(true);
    expect(v.safeParse(visualGuestMessageSchema, message).success).toBe(false);
    expect(
      v.safeParse(visualThemeMessageSchema, { ...message, extra: true })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(visualThemeSchema, { ...message.theme, appearance: "system" })
        .success,
    ).toBe(false);
  });
});
