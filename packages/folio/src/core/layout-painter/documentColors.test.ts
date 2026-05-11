import { describe, expect, test } from "bun:test";

import { getAutomaticTextColorForBackground } from "./documentColors";

describe("document automatic text color", () => {
  test("uses black automatic text on explicit white document shading", () => {
    expect(getAutomaticTextColorForBackground("#FFFFFF")).toBe("#000000");
  });

  test("uses white automatic text on explicit dark document shading", () => {
    expect(getAutomaticTextColorForBackground("#111111")).toBe("#FFFFFF");
  });

  test("uses black automatic text on mid-tone document shading", () => {
    expect(getAutomaticTextColorForBackground("#A9A9A9")).toBe("#000000");
  });

  test("leaves automatic text theme-adaptive when shading is not a concrete color", () => {
    expect(getAutomaticTextColorForBackground("auto")).toBeUndefined();
    expect(getAutomaticTextColorForBackground(undefined)).toBeUndefined();
  });
});
