import { describe, expect, test } from "bun:test";

import {
  DESKTOP_APPEARANCE_CHANGED_EVENT,
  DESKTOP_APPEARANCES,
  effectiveColorScheme,
} from "../src/shared/desktop-appearance";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const NATIVE_APPEARANCE = readNativeSource("appearance.rs");

describe("desktop appearance", () => {
  test("offers exactly the appearances the native side stores", () => {
    expect(rustEnumVariants(NATIVE_APPEARANCE, "Appearance")).toEqual([
      ...DESKTOP_APPEARANCES,
    ]);
  });

  test("listens for the event the native side emits", () => {
    expect(NATIVE_APPEARANCE).toContain(
      `pub const APPEARANCE_CHANGED_EVENT: &str = "${DESKTOP_APPEARANCE_CHANGED_EVENT}";`,
    );
  });

  test("a chosen scheme holds whatever the system prefers", () => {
    for (const systemPrefersDark of [false, true]) {
      expect(effectiveColorScheme("light", systemPrefersDark)).toBe("light");
      expect(effectiveColorScheme("dark", systemPrefersDark)).toBe("dark");
    }
    expect(effectiveColorScheme("system", false)).toBe("light");
    expect(effectiveColorScheme("system", true)).toBe("dark");
  });
});
