import { describe, expect, test } from "bun:test";

import { VISUAL_THEME_VARIABLES } from "@stll/api-contract/visual-theme";

import {
  readVisualTheme,
  readVisualThemeOrOmit,
} from "./generated-visual-theme";

const themeCss = await Bun.file(
  new URL("../../../../../packages/ui/src/styles/theme.css", import.meta.url),
).text();

describe("generated visual host theme", () => {
  test("every allowed token has an app source and reaches the guest map", () => {
    const values = new Map<string, string>(
      VISUAL_THEME_VARIABLES.map((name, index) => [name, `${index + 1}px`]),
    );
    for (const name of VISUAL_THEME_VARIABLES) {
      expect(themeCss).toContain(`${name}:`);
    }
    const theme = readVisualTheme({
      appearance: "dark",
      style: {
        getPropertyValue: (name) => values.get(name) ?? "",
        fontFamily: "sans-serif",
      },
    });
    expect(theme.appearance).toBe("dark");
    expect(Object.keys(theme.variables).toSorted()).toEqual(
      VISUAL_THEME_VARIABLES.toSorted(),
    );
    for (const name of VISUAL_THEME_VARIABLES) {
      expect(theme.variables[name]).toBe(values.get(name));
    }
  });

  test("uses the app font when inline Tailwind tokens have no custom property", () => {
    const theme = readVisualTheme({
      appearance: "light",
      style: {
        getPropertyValue: (name) => (name === "--font-sans" ? "" : "1px"),
        fontFamily: '"DM Sans", sans-serif',
      },
    });
    expect(theme.variables["--font-sans"]).toBe('"DM Sans", sans-serif');
  });

  test("surfaces a missing source token", () => {
    expect(() =>
      readVisualTheme({
        appearance: "light",
        style: { getPropertyValue: () => "", fontFamily: "sans-serif" },
      }),
    ).toThrow("Missing app visual theme token");
  });

  test("omits the theme and reports when a source token is missing", () => {
    const reported: unknown[] = [];
    const theme = readVisualThemeOrOmit({
      appearance: "light",
      style: {
        getPropertyValue: (name) => (name === "--background" ? "" : "1px"),
        fontFamily: "sans-serif",
      },
      report: (error) => reported.push(error),
    });
    expect(theme).toBeUndefined();
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain(
      "Missing app visual theme token: --background",
    );
  });

  test("returns the theme without reporting when every token is present", () => {
    const reported: unknown[] = [];
    const theme = readVisualThemeOrOmit({
      appearance: "dark",
      style: { getPropertyValue: () => "1px", fontFamily: "sans-serif" },
      report: (error) => reported.push(error),
    });
    expect(theme?.appearance).toBe("dark");
    expect(theme?.variables["--background"]).toBe("1px");
    expect(reported).toEqual([]);
  });
});
