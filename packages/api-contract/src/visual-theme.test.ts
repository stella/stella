import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { visualGuestMessageSchema } from "./visual-sandbox";
import {
  VISUAL_THEME_VARIABLES,
  visualThemeMessageSchema,
  visualThemeSchema,
} from "./visual-theme";

describe("visual theme boundary", () => {
  test("accepts every declared token with concrete colors and font stacks", () => {
    const variables = Object.fromEntries(
      VISUAL_THEME_VARIABLES.map((name) => [name, "oklch(0.7 0.1 150)"]),
    );
    expect(
      v.safeParse(visualThemeSchema, { appearance: "dark", variables }).success,
    ).toBe(true);
    expect(
      v.safeParse(visualThemeSchema, {
        appearance: "light",
        variables: { "--font-sans": '"Inter", system-ui, sans-serif' },
      }).success,
    ).toBe(true);
  });
  test("refuses empty, multi-declaration, and unbounded values for every token", () => {
    const unsafe = ["", "1px; 2px", "x".repeat(513)];
    for (const name of VISUAL_THEME_VARIABLES) {
      for (const value of unsafe) {
        expect(
          v.safeParse(visualThemeSchema, {
            appearance: "light",
            variables: { [name]: value },
          }).success,
        ).toBe(false);
      }
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
