import { panic } from "better-result";
import { readFileSync } from "node:fs";

/** A window's inner size in CSS pixels, as the native side creates it. */
export type DesktopWindowSize = { height: number; width: number };

const nativeSource = (file: string) =>
  readFileSync(new URL(`../src-tauri/src/${file}`, import.meta.url), "utf-8");

/**
 * Reads one `const NAME: f64 = 620.0;` line, so the size the native side
 * opens a window at is the only place the number is written.
 */
const nativeConstant = (source: string, name: string): number => {
  const match = new RegExp(
    String.raw`^const ${name}: f64 = (\d+(?:\.\d+)?);$`,
    "mu",
  ).exec(source);
  const value = Number(match?.[1]);
  if (!Number.isFinite(value) || value <= 0) {
    panic(`The native source declares no ${name}`);
  }
  return value;
};

const nativeSize = (
  file: string,
  width: string,
  height: string,
): DesktopWindowSize => {
  const source = nativeSource(file);
  return {
    height: nativeConstant(source, height),
    width: nativeConstant(source, width),
  };
};

/** The fixed-size windows that render the design system's controls. */
export const DESKTOP_WINDOW_SIZES = {
  onboarding: nativeSize("onboarding.rs", "WINDOW_WIDTH", "WINDOW_HEIGHT"),
  settings: nativeSize(
    "lib.rs",
    "SETTINGS_WINDOW_WIDTH",
    "SETTINGS_WINDOW_HEIGHT",
  ),
} as const satisfies Record<string, DesktopWindowSize>;
