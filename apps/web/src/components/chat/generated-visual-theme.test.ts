import { describe, expect, test } from "bun:test";

import { VISUAL_THEME_VARIABLES } from "@stll/api-contract/visual-theme";

import { readVisualTheme } from "./generated-visual-theme";

const themeCss = await Bun.file(new URL("../../../../../packages/ui/src/styles/theme.css", import.meta.url)).text();

describe("generated visual host theme", () => {
  test("every allowed token has an app source and reaches the guest map", () => {
    const values = new Map(VISUAL_THEME_VARIABLES.map((name, index) => [name, `${index + 1}px`]));
    for (const name of VISUAL_THEME_VARIABLES) {
      expect(themeCss).toContain(`${name}:`);
    }
    const theme = readVisualTheme({
      appearance: "dark",
      style: { getPropertyValue: (name) => values.get(name) ?? "", fontFamily: "sans-serif" },
    });
    expect(theme.appearance).toBe("dark");
    expect(Object.keys(theme.variables).sort()).toEqual([...VISUAL_THEME_VARIABLES].sort());
    for (const name of VISUAL_THEME_VARIABLES) {
      expect(theme.variables[name]).toBe(values.get(name));
    }
  });

  test("uses the app font when inline Tailwind tokens have no custom property", () => {
    const theme = readVisualTheme({
      appearance: "light",
      style: { getPropertyValue: (name) => name === "--font-sans" ? "" : "1px", fontFamily: '"DM Sans", sans-serif' },
    });
    expect(theme.variables["--font-sans"]).toBe('"DM Sans", sans-serif');
  });

  test("surfaces a missing source token", () => {
    expect(() => readVisualTheme({
      appearance: "light", style: { getPropertyValue: () => "", fontFamily: "sans-serif" },
    })).toThrow("Missing app visual theme token");
  });
});
